-- One row per push the Worker decided to send (see the table comment in schema.sql).
--
-- Additive and idempotent: no existing table or row is touched.
-- Applied with: npx wrangler d1 execute squad-goals --remote --file=migrations/012-push-log.sql
CREATE TABLE IF NOT EXISTS push_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  ref_id INTEGER,
  pref TEXT NOT NULL,
  tag TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  recipients INTEGER NOT NULL,
  accepted INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS push_log_ref ON push_log(scope, ref_id, created_at);
