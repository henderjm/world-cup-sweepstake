-- Prediction game entries (see the table comment in schema.sql for the full
-- contract: points IS NULL = unscored, gameweek stamped at scoring time for
-- the fantasy bonus join, actuals denormalised so history outlives the feed).
--
-- Additive and idempotent: no existing table or row is touched.
-- Applied with: npx wrangler d1 execute squad-goals --remote --file=migrations/010-predictions.sql
CREATE TABLE IF NOT EXISTS prediction_entries (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  match_id INTEGER NOT NULL,
  competition TEXT NOT NULL,
  home_goals INTEGER NOT NULL,
  away_goals INTEGER NOT NULL,
  gameweek INTEGER,
  points INTEGER,
  exact INTEGER,
  actual_home INTEGER,
  actual_away INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  scored_at TEXT,
  PRIMARY KEY (user_id, match_id)
);
CREATE INDEX IF NOT EXISTS prediction_entries_match ON prediction_entries(match_id);
CREATE INDEX IF NOT EXISTS prediction_entries_gameweek ON prediction_entries(gameweek);
