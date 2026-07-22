-- Squad Goals accounts schema (Cloudflare D1 / SQLite).
-- Applied with: npx wrangler d1 execute squad-goals --remote --file=schema.sql
-- Idempotent: safe to re-run on an existing database.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub TEXT NOT NULL UNIQUE,      -- Google's stable subject id, the real identity key
  email TEXT NOT NULL,
  name TEXT,
  avatar TEXT,
  -- Notification preferences, stored now so Phase 3 (push) is pure delivery.
  prefs TEXT NOT NULL DEFAULT '{"goals":true,"kickoff":true,"fulltime":true,"red":false,"analysis":false}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Bearer sessions: the token itself never touches the database, only its SHA-256.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

-- Followed clubs, the targeting set for Phase 3 goal/kickoff/full-time alerts.
CREATE TABLE IF NOT EXISTS follows (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  competition TEXT NOT NULL,
  team TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, competition, team)
);
CREATE INDEX IF NOT EXISTS follows_team ON follows(competition, team);

-- Banter: an append-only comment log per match, and one row per user x match x
-- emoji rolled up to counts on read. Signed-in users only; names come from users.
CREATE TABLE IF NOT EXISTS banter_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS banter_messages_match ON banter_messages(match_id, id);

CREATE TABLE IF NOT EXISTS banter_reactions (
  match_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (match_id, user_id, emoji)
);

-- Web Push subscriptions, one row per browser/device. The endpoint is the identity;
-- a dead endpoint (404/410 from the push service) is pruned on send.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS push_subs_user ON push_subscriptions(user_id);

-- Last-notified state per match, so the notification cron only announces changes.
CREATE TABLE IF NOT EXISTS notify_state (
  match_id INTEGER PRIMARY KEY,
  signature TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Fantasy H2H draft league (Phase 4). Premier League only: its 38-matchday season
-- maps 1:1 onto weekly head-to-head gameweeks the way a knockout-plus-league-phase
-- competition doesn't.

-- The draftable player pool. id is API-Football's player id (propagated
-- through mapApiFootballMatchDetail, not a local autoincrement, so it lines
-- up with the ids already carried on goals/cards/subs. Populated by
-- scripts/fetch-fantasy-players.mjs, primarily from the /players/squads endpoint;
-- endpoint; `active` lets a departed player be hidden from new drafts/waivers
-- without losing their historical scores.
CREATE TABLE IF NOT EXISTS fantasy_players (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  team TEXT NOT NULL,
  position TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fantasy_leagues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  commissioner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_code TEXT NOT NULL UNIQUE,
  draft_status TEXT NOT NULL DEFAULT 'pending', -- pending | drafting | complete
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fantasy_league_members (
  league_id INTEGER NOT NULL REFERENCES fantasy_leagues(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  draft_position INTEGER, -- this member's slot in the snake order, set when the draft starts
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (league_id, user_id)
);
CREATE INDEX IF NOT EXISTS fantasy_league_members_user ON fantasy_league_members(user_id);

-- Append-only draft log, the durable source of truth the FantasyDraftRoom Durable
-- Object writes to on every pick (so a DO eviction can rehydrate from here).
CREATE TABLE IF NOT EXISTS fantasy_draft_picks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id INTEGER NOT NULL REFERENCES fantasy_leagues(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  pick_in_round INTEGER NOT NULL,
  overall_pick INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES fantasy_players(id),
  picked_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS fantasy_draft_picks_league ON fantasy_draft_picks(league_id, overall_pick);

-- Current squad ownership, one row per player a manager holds in a given league
-- (a player can be on different managers' rosters across different leagues).
CREATE TABLE IF NOT EXISTS fantasy_rosters (
  league_id INTEGER NOT NULL REFERENCES fantasy_leagues(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES fantasy_players(id),
  acquired_via TEXT NOT NULL DEFAULT 'draft', -- draft | waiver | free_agent
  acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (league_id, user_id, player_id)
);
CREATE INDEX IF NOT EXISTS fantasy_rosters_player ON fantasy_rosters(league_id, player_id);

-- A manager's starting XI for one gameweek. Absence from this table for a given
-- gameweek means "use the previous gameweek's lineup" (computed at scoring time,
-- never copy-written), so inaction never zeroes a roster.
CREATE TABLE IF NOT EXISTS fantasy_lineups (
  league_id INTEGER NOT NULL REFERENCES fantasy_leagues(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gameweek INTEGER NOT NULL,
  player_id INTEGER NOT NULL REFERENCES fantasy_players(id),
  is_captain INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (league_id, user_id, gameweek, player_id)
);

-- A player's raw fantasy points for a gameweek, computed once from match data and
-- shared across every league/roster that has them (league-independent by design,
-- since the same player can sit on many managers' squads).
CREATE TABLE IF NOT EXISTS fantasy_player_scores (
  gameweek INTEGER NOT NULL,
  player_id INTEGER NOT NULL REFERENCES fantasy_players(id),
  points REAL NOT NULL DEFAULT 0,
  breakdown TEXT, -- JSON: {goals, assists, cleanSheet, appearance, cards, ownGoals}
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (gameweek, player_id)
);

-- Dedup ledger: a finished match's points are applied to fantasy_player_scores
-- exactly once, the same "first sighting only" discipline as notify_state.
CREATE TABLE IF NOT EXISTS fantasy_scored_matches (
  match_id INTEGER PRIMARY KEY,
  scored_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A manager's rolled-up total for one gameweek in one league (starting lineup's
-- player scores, captain doubled), recomputed as that gameweek's matches finish.
CREATE TABLE IF NOT EXISTS fantasy_gameweek_scores (
  league_id INTEGER NOT NULL REFERENCES fantasy_leagues(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gameweek INTEGER NOT NULL,
  points REAL NOT NULL DEFAULT 0,
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (league_id, user_id, gameweek)
);

-- Head-to-head schedule, generated by round-robin once a league's draft completes.
CREATE TABLE IF NOT EXISTS fantasy_h2h_fixtures (
  league_id INTEGER NOT NULL REFERENCES fantasy_leagues(id) ON DELETE CASCADE,
  gameweek INTEGER NOT NULL,
  home_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  away_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  home_score REAL,
  away_score REAL,
  PRIMARY KEY (league_id, gameweek, home_user_id)
);
CREATE INDEX IF NOT EXISTS fantasy_h2h_fixtures_away ON fantasy_h2h_fixtures(league_id, gameweek, away_user_id);

-- Free-agency waiver claims. Processed in worst-record-first priority order as
-- part of the weekly scoring pass; a successful claimant moves to the back of
-- priority for next time (standard fantasy-league waiver convention).
CREATE TABLE IF NOT EXISTS fantasy_waivers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id INTEGER NOT NULL REFERENCES fantasy_leagues(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  add_player_id INTEGER NOT NULL REFERENCES fantasy_players(id),
  drop_player_id INTEGER REFERENCES fantasy_players(id),
  priority INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | processed | rejected
  gameweek INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT
);
CREATE INDEX IF NOT EXISTS fantasy_waivers_pending ON fantasy_waivers(league_id, status);
