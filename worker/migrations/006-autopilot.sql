-- One-time migration for databases created before dead-team autopilot shipped.
-- schema.sql's CREATE TABLE IF NOT EXISTS cannot retrofit a column onto an
-- existing table, and ALTER TABLE is not idempotent in SQLite (a second run
-- fails with "duplicate column name"), so this file exists separately and is
-- meant to be applied exactly once. Same pattern as 003-bot-managers.sql and
-- 004-draft-pick-via.sql.
--
-- Every existing membership row is a manager playing their own team, so the
-- DEFAULT 0 is the correct backfill for all of them and no UPDATE is needed.
-- autopilot_since is nullable and stays NULL while autopilot is off.
--
-- Skip this file entirely for a database created after this shipped.
--
-- Apply with:
--   npx wrangler d1 execute squad-goals --remote --file=worker/migrations/006-autopilot.sql
ALTER TABLE fantasy_league_members ADD COLUMN autopilot INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fantasy_league_members ADD COLUMN autopilot_since TEXT;
