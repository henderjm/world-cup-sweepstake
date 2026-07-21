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
