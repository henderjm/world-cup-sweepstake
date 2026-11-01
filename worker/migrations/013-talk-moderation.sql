-- Talk moderation (src/talkModeration.js): reports, moderator hides, muted
-- accounts and the moderator list. Additive and idempotent: banter_messages
-- itself is untouched, and a Worker running before this is applied keeps
-- serving banter unmoderated (handleBanter checks for these tables).
-- Applied with: npx wrangler d1 execute squad-goals --remote --file=migrations/013-talk-moderation.sql
CREATE TABLE IF NOT EXISTS banter_reports (
  message_id INTEGER NOT NULL REFERENCES banter_messages(id) ON DELETE CASCADE,
  reporter_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (message_id, reporter_user_id)
);
CREATE TABLE IF NOT EXISTS talk_hidden (
  message_id INTEGER PRIMARY KEY REFERENCES banter_messages(id) ON DELETE CASCADE,
  hidden_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS talk_mutes (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  muted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Set by hand, never from the app: INSERT INTO talk_moderators (user_id)
-- SELECT id FROM users WHERE email = '<the owner's email>';
CREATE TABLE IF NOT EXISTS talk_moderators (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- The per-account rate limit reads a user's latest post.
CREATE INDEX IF NOT EXISTS banter_messages_user ON banter_messages(user_id, id);
