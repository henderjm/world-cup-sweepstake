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
  -- "draft" and "recap" default true (unlike the optional match alerts):
  -- joining a league is itself an active opt-in, so a manager should hear
  -- about their own draft and their own league's weekly recap unless they turn
  -- it off. An account created before either key existed has no entry for it
  -- in its stored JSON at all; publicUser() (worker.js) merges DEFAULT_PREFS
  -- underneath whatever is stored so a missing key still reads as true rather
  -- than requiring a backfill.
  prefs TEXT NOT NULL DEFAULT '{"goals":true,"kickoff":true,"fulltime":true,"red":false,"analysis":false,"draft":true,"recap":true}',
  -- 1 for a bot manager filling an empty league seat (see src/fantasyBots.js).
  -- google_sub is the AUTHORITY on whether a row is a bot, not this column: a
  -- bot's sub is "bot:<leagueId>:<random>", which is not a possible Google
  -- subject (Google issues decimal digit strings), so a bot is unauthenticable
  -- by construction. This flag exists so the surfaces that must exclude or
  -- label a bot can do it with a plain predicate instead of a LIKE over
  -- google_sub, and it is set once at insert and never updated.
  --
  -- See worker/migrations/003-bot-managers.sql for adding this to a database
  -- created before bot managers shipped (fresh databases get it from here).
  is_bot INTEGER NOT NULL DEFAULT 0,
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

-- A manager's own pre-draft/in-draft shortlist (the "queue" - see
-- src/fantasyDraft.js's addToQueue/toggleQueue/moveQueueItem). Replaced
-- wholesale on every save (delete-then-insert for that league+user, same
-- pattern as fantasy_lineups below) rather than diffed, since the client
-- always sends the whole ordered list. `position` is the queue's own
-- 0-based order, not a player attribute.
--
-- Read directly by FantasyDraftRoom's alarm autopick (worker/draftRoom.js),
-- which rebuilds every member's queue from here on each wake, exactly like
-- the pick log: a DO eviction mid-draft never loses a manager's shortlist.
-- Written through a plain D1-backed Worker route rather than through the
-- Durable Object - a manager only ever writes their own row, so there is no
-- turn-order coordination to arbitrate, unlike an actual pick.
CREATE TABLE IF NOT EXISTS fantasy_draft_queue (
  league_id INTEGER NOT NULL REFERENCES fantasy_leagues(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES fantasy_players(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (league_id, user_id, player_id)
);
CREATE INDEX IF NOT EXISTS fantasy_draft_queue_lookup ON fantasy_draft_queue(league_id, user_id, position);

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

-- A player's raw fantasy points for ONE MATCH, computed once from match data and
-- shared across every league/roster that has them (league-independent by design,
-- since the same player can sit on many managers' squads). `gameweek` is the
-- calendar WINDOW that match was played in (src/fantasyCalendar.js), not the
-- provider's matchday label.
--
-- Keyed on the match and not on the gameweek: a club can play twice inside one
-- window (a double gameweek, when a postponed fixture is replayed later in the
-- season), and both matches score into that gameweek. The predecessor table
-- fantasy_player_scores was keyed on (gameweek, player_id) and written with
-- INSERT OR REPLACE, so a player's second match of a double gameweek silently
-- overwrote his first instead of adding to it. A gameweek total is now always
-- SUM(points) over this table, never a single row.
-- See worker/migrations/002-gameweek-windows.sql for dropping the old table on
-- an existing database (fresh databases never create it).
CREATE TABLE IF NOT EXISTS fantasy_player_match_scores (
  match_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL REFERENCES fantasy_players(id),
  gameweek INTEGER NOT NULL,
  points REAL NOT NULL DEFAULT 0,
  breakdown TEXT, -- JSON: {goals, assists, cleanSheet, appearance, cards, ownGoals}
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (match_id, player_id)
);
CREATE INDEX IF NOT EXISTS fantasy_player_match_scores_gw ON fantasy_player_match_scores(gameweek, player_id);

-- Dedup ledger: a finished match's points are applied to
-- fantasy_player_match_scores exactly once, the same "first sighting only"
-- discipline as notify_state.
CREATE TABLE IF NOT EXISTS fantasy_scored_matches (
  match_id INTEGER PRIMARY KEY,
  scored_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Expected points (xP), a separate table rather than new columns on
-- fantasy_players so this file stays idempotent (this schema is applied with
-- `wrangler d1 execute` and has no ALTER TABLE precedent - see CLAUDE.md; a
-- CREATE TABLE IF NOT EXISTS for a brand-new table is safe to re-run whether
-- fantasy_players already existed from an earlier deploy or not).
--
-- historical_xp/historical_basis are the baked pool's own figure
-- (data/PL/players.json's xp/xpBasis - see
-- scripts/fetch-fantasy-players.mjs), refreshed whenever the pool is
-- upserted (upsertFantasyPlayerPool in worker/worker.js). xp/xp_basis are
-- what the app actually reads: equal to the historical figure until a
-- gameweek has been played, then recomputed by blending in this season's own
-- scoring (runScheduledFantasyXpBlend, src/fantasyExpectedPoints.js's
-- blendWithCurrentSeason) - kept separate from the historical columns so
-- every blend recomputes from the same untouched prior rather than
-- compounding the previous tick's already-blended figure.
CREATE TABLE IF NOT EXISTS fantasy_player_xp (
  player_id INTEGER PRIMARY KEY REFERENCES fantasy_players(id),
  historical_xp REAL,
  historical_basis TEXT,
  xp REAL,
  xp_basis TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Single-row marker of the last gameweek runScheduledFantasyXpBlend has
-- already blended through, so the cron can skip recomputing every active
-- player on every one-minute tick and only redo it once a new gameweek has
-- actually completed (see worker/worker.js).
CREATE TABLE IF NOT EXISTS fantasy_xp_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_completed_gameweek INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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

-- Advisory lock so two overlapping cron ticks cannot both do a league's waiver
-- run work. One row per league at most; acquired with a single guarded upsert
-- (atomic in SQLite, so exactly one of two racing ticks sees changes = 1) and
-- released inside the same atomic batch that commits the run.
--
-- This is a LIVENESS mechanism, never a correctness one, and the distinction
-- matters: `expires_at` is a lease so a tick that dies mid-run cannot wedge a
-- league's waivers forever, but nothing about correctness depends on that
-- clock. Even if the lease expired instantly and both ticks ran the whole
-- thing, the unique index on fantasy_waiver_runs(league_id, gameweek) plus the
-- single atomic batch mean only one can commit and the loser's entire batch
-- rolls back. The lock only stops the wasted work and the duplicate upstream
-- reads. `holder` is a per-attempt random token so a tick can only ever
-- release the lease it actually took, not a successor's.
CREATE TABLE IF NOT EXISTS fantasy_waiver_locks (
  league_id INTEGER PRIMARY KEY REFERENCES fantasy_leagues(id) ON DELETE CASCADE,
  gameweek INTEGER NOT NULL,
  holder TEXT NOT NULL,
  acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- Defense in depth for the draft room's commit path: blockConcurrencyWhile in
-- the FantasyDraftRoom Durable Object already serializes picks within one
-- instance, but this index is what turns a same-slot double write (an eviction-
-- boundary race across two instances, in theory) into a rejected insert instead
-- of silent duplicate-pick corruption.
CREATE UNIQUE INDEX IF NOT EXISTS fantasy_draft_picks_league_overall ON fantasy_draft_picks(league_id, overall_pick);

-- League feed (Phase 4.6): ONE append-only stream per league carrying both
-- what the app did and what managers said about it. Deliberately one table,
-- not a chat table beside a transaction log: the whole reason built-in league
-- chat works on Sleeper and is abandoned on ESPN/Yahoo is that a move and the
-- reaction to it appear on the same surface, in one timeline. Splitting them
-- would rebuild the thing that fails.
--
-- kind = 'message': a human wrote it. user_id is the author, `text` is the
--   whole content, event/payload are NULL.
-- kind = 'system': the app wrote it. user_id is NULL, `event` names what
--   happened (see CHAT_EVENTS in src/fantasyChat.js) and `payload` is JSON
--   carrying the FACTS, never pre-rendered prose - the wording is produced at
--   read time by describeChatEvent so a copy change never leaves old rows
--   speaking an older dialect.
--
-- Payload values are denormalised on write (a manager's display name is copied
-- in rather than joined at read time): the feed is a permanent history and
-- must keep reading correctly after an account is renamed or deleted, which is
-- also why user_id is nullable here and NOT the source of the displayed name.
CREATE TABLE IF NOT EXISTS fantasy_chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id INTEGER NOT NULL REFERENCES fantasy_leagues(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'message', -- message | system
  event TEXT,    -- system rows only
  payload TEXT,  -- system rows only, JSON
  text TEXT,     -- human rows only
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS fantasy_chat_messages_league ON fantasy_chat_messages(league_id, id);

-- Emoji reactions, one row per user x message x emoji, rolled up to counts on
-- read exactly like banter_reactions. Keyed on the message rather than on the
-- league, because in a running feed the interesting question is which MOVE
-- everyone laughed at.
CREATE TABLE IF NOT EXISTS fantasy_chat_reactions (
  message_id INTEGER NOT NULL REFERENCES fantasy_chat_messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (message_id, user_id, emoji)
);

-- Dedup ledger for the AI weekly recap: exactly one per league per gameweek,
-- ever. The unique index is the real gate - the cron checks it cheaply first,
-- then commits the ledger row and the recap's own feed message in ONE batch,
-- so two overlapping ticks cannot both post (the loser's whole batch is
-- rejected atomically, feed message included). prompt_version records which
-- build's prompt wrote it, so a later prompt change is traceable rather than
-- silently mixed in.
CREATE TABLE IF NOT EXISTS fantasy_league_recaps (
  league_id INTEGER NOT NULL REFERENCES fantasy_leagues(id) ON DELETE CASCADE,
  gameweek INTEGER NOT NULL,
  prompt_version INTEGER NOT NULL DEFAULT 1,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (league_id, gameweek)
);

-- API-Football quota analytics. The Worker proxies a paid plan and until now
-- measured nothing, so the daily allowance could be half gone by lunchtime and
-- the first anyone knew was a 429 during a live match.
--
-- Counts, never one row per request. fetchJson is the single chokepoint for
-- every upstream call and runs on every proxied poll, so a row per request
-- would put a D1 write in front of a live match's traffic. Isolates accumulate
-- in memory (src/apiQuotaStore.js) and flush counts here, which collapses
-- thousands of requests into at most a handful of rows a day.
--
-- upstream is 0/1 rather than a status string on purpose: the one number worth
-- watching is the share of demand the edge absorbed, and a cached response
-- REPLAYS the stored rate-limit headers, so "was this real spend" is the only
-- distinction the maths needs (see isUpstreamHit in src/apiQuota.js).
CREATE TABLE IF NOT EXISTS api_usage_daily (
  day TEXT NOT NULL,          -- UTC date; the provider's allowance resets at UTC midnight
  endpoint TEXT NOT NULL,     -- endpointFamily(), query string stripped, so ids do not fan out
  upstream INTEGER NOT NULL,  -- 1 = a real call against the allowance, 0 = served from the edge
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, endpoint, upstream)
);

-- The provider's own view of the day, kept beside our counts because it is the
-- more trustworthy of the two: the same key is also spent by the hourly Pages
-- bake and the player-pool script, neither of which passes through the Worker.
-- daily_remaining only ever falls within a UTC day, so the flush takes MIN of
-- what is stored and what it saw; that way an out-of-order flush from another
-- isolate can never make the gauge appear to refill mid-day.
CREATE TABLE IF NOT EXISTS api_usage_quota (
  day TEXT PRIMARY KEY,
  daily_limit INTEGER,
  daily_remaining INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
