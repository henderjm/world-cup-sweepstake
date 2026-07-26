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
  -- "draft" defaults true (unlike the optional match alerts): joining a
  -- league is itself an active opt-in, so a manager should hear about their
  -- own draft unless they turn it off. An account created before this key
  -- existed has no "draft" entry in its stored JSON at all; publicUser()
  -- (worker.js) merges DEFAULT_PREFS underneath whatever is stored so a
  -- missing key still reads as true rather than requiring a backfill.
  prefs TEXT NOT NULL DEFAULT '{"goals":true,"kickoff":true,"fulltime":true,"red":false,"analysis":false,"draft":true}',
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

-- Draft scheduling: a commissioner picks a future UTC instant for a still-
-- pending league's draft to start. Absence of a row means "not scheduled
-- yet", the pre-existing behaviour (click Start Draft, it begins now), which
-- must keep working - scheduling is additive, never a replacement. One row
-- per league (PRIMARY KEY league_id), upserted on reschedule; deleted when
-- the commissioner clears it or once the draft actually starts.
CREATE TABLE IF NOT EXISTS fantasy_draft_schedule (
  league_id INTEGER PRIMARY KEY REFERENCES fantasy_leagues(id) ON DELETE CASCADE,
  scheduled_at TEXT NOT NULL, -- ISO 8601 UTC
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Dedup ledger for the three one-time draft reminders ("24h", "1h", "start"),
-- the same "insert once, check before sending" discipline as notify_state
-- and fantasy_scored_matches: a minute-by-minute cron must fire each kind
-- exactly once per scheduled instant, never on every tick. A reschedule (see
-- worker.js's schedule route) clears every row for that league, since
-- reminders already sent for the OLD time must not suppress the same kind
-- firing again for the new one.
CREATE TABLE IF NOT EXISTS fantasy_draft_reminders (
  league_id INTEGER NOT NULL REFERENCES fantasy_leagues(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, -- 24h | 1h | start
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (league_id, kind)
);

-- Free-agency waiver claims (Phase 4.4). `priority` is the claimant's OWN
-- ranking among their own claims (1 = try first), not the league-wide waiver
-- order (that lives in fantasy_waiver_state). Resolved by src/fantasyWaivers.js
-- as part of the gameweek-advance cron pass; a claim's `gameweek` is the
-- gameweek it was submitted during, which is also the gameweek whose
-- settlement triggers the run that resolves it (see fantasy_waiver_runs).
-- `bid` and `reason` were added after this table shipped empty in production;
-- see worker/migrations/001-waivers.sql for the one-time ALTER on existing
-- databases (fresh databases get them straight from this CREATE TABLE).
CREATE TABLE IF NOT EXISTS fantasy_waivers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id INTEGER NOT NULL REFERENCES fantasy_leagues(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  add_player_id INTEGER NOT NULL REFERENCES fantasy_players(id),
  drop_player_id INTEGER REFERENCES fantasy_players(id),
  priority INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | processed | rejected
  gameweek INTEGER NOT NULL,
  bid INTEGER, -- FAAB blind bid; NULL for rolling/reverse_standings leagues, always >= 0
  reason TEXT, -- rejection reason shown in the UI; NULL until resolved, NULL forever if processed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT
);
CREATE INDEX IF NOT EXISTS fantasy_waivers_pending ON fantasy_waivers(league_id, status);

-- Per-league waiver configuration. Absence of a row means the defaults (faab,
-- DEFAULT_FAAB_BUDGET) apply, so a league never needs an explicit row until
-- its commissioner actually changes something.
CREATE TABLE IF NOT EXISTS fantasy_waiver_settings (
  league_id INTEGER PRIMARY KEY REFERENCES fantasy_leagues(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'faab', -- faab | rolling | reverse_standings
  faab_budget INTEGER NOT NULL DEFAULT 100,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-manager waiver state: FAAB budget remaining and league-wide waiver
-- priority (1 = first call). Lazily initialized on first use (see
-- ensureLeagueWaiverState in worker.js), seeded from reverse draft order (the
-- standard "worst drafter gets first waiver call" convention) so a league
-- that never touches waivers never needs a row either.
CREATE TABLE IF NOT EXISTS fantasy_waiver_state (
  league_id INTEGER NOT NULL REFERENCES fantasy_leagues(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  faab_remaining INTEGER NOT NULL DEFAULT 100,
  priority INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (league_id, user_id)
);

-- The waiver wire: a player dropped via either acquisition path (instant free
-- agency or a winning waiver claim) sits here, unavailable to instant free
-- agency, until the next waiver run clears it (see fantasy_waiver_runs).
-- This is what stops a drop-and-instantly-re-add cycle from dodging the
-- queue: the dropped player is ON_WAIVERS, not immediately FREE_AGENT again.
CREATE TABLE IF NOT EXISTS fantasy_waiver_wire (
  league_id INTEGER NOT NULL REFERENCES fantasy_leagues(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES fantasy_players(id),
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  clears_after_gameweek INTEGER NOT NULL, -- the gameweek whose run clears this entry
  PRIMARY KEY (league_id, player_id)
);

-- One row per league per gameweek a waiver run has processed. The unique
-- index is the run's idempotency gate: the cron attempts this INSERT before
-- doing any work, and a conflict means the run already happened, so it skips
-- (the same "insert first, work only on success" pattern the draft picks'
-- unique index and fantasy_scored_matches' dedup ledger already use).
-- fantasy_waivers.gameweek is the natural link back to a run's claims: every
-- claim submitted during gameweek N is resolved by the run for (league, N).
CREATE TABLE IF NOT EXISTS fantasy_waiver_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id INTEGER NOT NULL REFERENCES fantasy_leagues(id) ON DELETE CASCADE,
  gameweek INTEGER NOT NULL,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS fantasy_waiver_runs_once ON fantasy_waiver_runs(league_id, gameweek);

-- Defense in depth for the draft room's commit path: blockConcurrencyWhile in
-- the FantasyDraftRoom Durable Object already serializes picks within one
-- instance, but this index is what turns a same-slot double write (an eviction-
-- boundary race across two instances, in theory) into a rejected insert instead
-- of silent duplicate-pick corruption.
CREATE UNIQUE INDEX IF NOT EXISTS fantasy_draft_picks_league_overall ON fantasy_draft_picks(league_id, overall_pick);
