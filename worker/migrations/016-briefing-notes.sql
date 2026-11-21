-- The Home briefing's AI note: one line per human manager per league per
-- gameweek (runScheduledBriefingNotes in worker/worker.js). The primary key is
-- the claim, so two overlapping cron ticks never pay for the same note; a row
-- in any state means "handled", and failed or rejected notes are not retried.
--
-- A Worker running before this is applied serves the briefing without notes
-- and the cron pass returns early.
--
-- Apply with:
--   npx wrangler d1 execute squad-goals --remote --file worker/migrations/016-briefing-notes.sql
-- Fresh databases get this table straight from worker/schema.sql instead.
CREATE TABLE IF NOT EXISTS briefing_notes (
  league_id INTEGER NOT NULL REFERENCES fantasy_leagues(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gameweek INTEGER NOT NULL,
  state TEXT NOT NULL,          -- sending | done | rejected | failed
  line TEXT,                    -- set only when state = done
  prompt_version INTEGER,
  facts_key TEXT,               -- noteFactsKey at writing time; shown only while it still matches
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (league_id, user_id, gameweek)
);
CREATE INDEX IF NOT EXISTS briefing_notes_created ON briefing_notes(created_at);
