-- One-time migration for databases created before the post-draft recap
-- shipped. Unlike 003 and 004 this adds only a NEW table, which schema.sql's
-- CREATE TABLE IF NOT EXISTS already handles idempotently, so this file exists
-- purely so the migration list stays a complete record of what production
-- needs. Re-running it is harmless.
--
-- Apply with:
--   npx wrangler d1 execute squad-goals --remote --file=worker/migrations/005-draft-recap.sql
--
-- Or simply re-apply worker/schema.sql, which contains the identical statement.
CREATE TABLE IF NOT EXISTS fantasy_league_draft_recaps (
  league_id INTEGER PRIMARY KEY REFERENCES fantasy_leagues(id) ON DELETE CASCADE,
  prompt_version INTEGER NOT NULL DEFAULT 1,
  generated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
