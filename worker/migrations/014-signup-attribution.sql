-- Sign-up attribution (src/attribution.js): where a person came from when
-- they first signed in. Four nullable columns on users, written at INSERT
-- only; handleGoogleAuth's ON CONFLICT branch never touches them, so a later
-- visit cannot rewrite an existing manager's origin.
--
-- NULL means "signed up before this existed" (every existing row) and is
-- deliberately never backfilled, the same discipline as fantasy_draft_picks.via:
-- a default of 'direct' would assert an origin nobody measured.
--
-- Values are already cleaned (lowercase, [a-z0-9._-], 64 chars max) on both
-- the client and the Worker, so they are safe to GROUP BY straight from SQL;
-- see scripts/metrics/14-signups-by-source.sql.
--
-- A Worker running before this is applied keeps signing people in: the
-- attributed INSERT fails on the missing column and handleGoogleAuth retries
-- the plain one, logging that the attribution was dropped.
--
-- Apply with:
--   npx wrangler d1 execute squad-goals --remote --file worker/migrations/014-signup-attribution.sql
-- Fresh databases get these columns straight from worker/schema.sql instead.
ALTER TABLE users ADD COLUMN signup_source TEXT;
ALTER TABLE users ADD COLUMN signup_medium TEXT;
ALTER TABLE users ADD COLUMN signup_campaign TEXT;
ALTER TABLE users ADD COLUMN signup_landing TEXT;
