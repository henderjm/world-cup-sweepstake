-- One-time migration for databases created before Phase 4.4 (free agency and
-- waivers). schema.sql's CREATE TABLE IF NOT EXISTS cannot retrofit new
-- columns onto an existing table (ALTER TABLE is not idempotent in SQLite: a
-- second run fails with "duplicate column name"), so this file exists
-- separately and is meant to be applied exactly once.
--
-- fantasy_waivers was verified empty in production at the time this was
-- written, so there is no existing data to backfill: every row created going
-- forward already carries `bid` and `reason` via schema.sql's updated CREATE
-- TABLE definition. Skip this file entirely for a database that did not exist
-- before Phase 4.4 shipped.
--
-- Apply with:
--   npx wrangler d1 execute squad-goals --remote --file=worker/migrations/001-waivers.sql
ALTER TABLE fantasy_waivers ADD COLUMN bid INTEGER;
ALTER TABLE fantasy_waivers ADD COLUMN reason TEXT;
