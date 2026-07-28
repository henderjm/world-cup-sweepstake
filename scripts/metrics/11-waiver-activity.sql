-- QUESTION: Is anyone using waivers and free agency, and do the runs work?
--
-- HOW TO READ: one row per gameweek per league that has seen a claim. Waivers
-- are the mid-season habit loop, so claims appearing in later gameweeks is the
-- strongest evidence in the whole database that a league is still alive.
--
-- `pending` is the alarm column. A claim for a gameweek whose run has already
-- happened (`run_at` is not null) should be zero: anything else means claims
-- are being orphaned, which is the failure the roll-forward UPDATE in
-- runLeagueWaiverRun exists to prevent. `rejected` being high is normal and
-- healthy (contested players), not a bug.
--
-- `instant_adds` counts free-agent pickups from fantasy_rosters instead of
-- fantasy_waivers, because the instant path never files a claim; without it,
-- half of all acquisition activity would be invisible here.
SELECT
  w.league_id,
  w.gameweek,
  COUNT(*) AS claims,
  COUNT(DISTINCT w.user_id) AS claiming_managers,
  SUM(CASE WHEN w.status = 'processed' THEN 1 ELSE 0 END) AS processed,
  SUM(CASE WHEN w.status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
  SUM(CASE WHEN w.status = 'pending' THEN 1 ELSE 0 END) AS pending,
  ROUND(AVG(w.bid), 1) AS avg_faab_bid,
  (SELECT COUNT(*) FROM fantasy_rosters r
    WHERE r.league_id = w.league_id AND r.acquired_via = 'free_agent') AS instant_adds_league_total,
  (SELECT MAX(run.processed_at) FROM fantasy_waiver_runs run
    WHERE run.league_id = w.league_id AND run.gameweek = w.gameweek) AS run_at
FROM fantasy_waivers w
GROUP BY w.league_id, w.gameweek
ORDER BY w.league_id, w.gameweek;
