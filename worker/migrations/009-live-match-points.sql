-- Provisional in-match fantasy points (see the table comment in schema.sql).
--
-- Additive and idempotent: no existing table or row is touched. Before this,
-- a player's points did not exist until his match was FINISHED, so the My team
-- pitch showed "in play" beside a zero for the whole game.
CREATE TABLE IF NOT EXISTS fantasy_live_match_points (
  match_id INTEGER PRIMARY KEY,
  gameweek INTEGER NOT NULL,
  scores TEXT NOT NULL,
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fantasy_live_match_points_gw
  ON fantasy_live_match_points (gameweek);
