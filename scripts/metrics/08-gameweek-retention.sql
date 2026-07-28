-- QUESTION: Gameweek by gameweek, how much of the drafted manager base is
-- still turning up?
--
-- HOW TO READ: one row per gameweek. `eligible_managers` is every seat in
-- every drafted league, so it is the denominator that should stay flat while
-- the activity columns decay: the slope of `pct_set_lineup` IS the retention
-- curve. `managers_set_lineup` counts managers who explicitly saved an XI for
-- that gameweek; `managers_claimed` touched the waiver wire during it.
--
-- Read `pct_set_lineup` as a FLOOR on engagement, never as attendance. An
-- absent row means "inherit the previous gameweek's XI" by design (see
-- resolveEffectiveLineup in src/fantasyLineups.js), so a manager who is happy
-- with a settled squad looks identical here to one who has left. What the
-- number is genuinely good for is the TREND and the comparison between
-- gameweeks, since that ambiguity is constant across weeks.
SELECT
  gw.gameweek,
  (SELECT COUNT(*) FROM fantasy_league_members m
     JOIN fantasy_leagues l ON l.id = m.league_id
    WHERE l.draft_status = 'complete') AS eligible_managers,
  (SELECT COUNT(DISTINCT fl.league_id || ':' || fl.user_id)
     FROM fantasy_lineups fl WHERE fl.gameweek = gw.gameweek) AS managers_set_lineup,
  (SELECT COUNT(DISTINCT w.league_id || ':' || w.user_id)
     FROM fantasy_waivers w WHERE w.gameweek = gw.gameweek) AS managers_claimed,
  (SELECT COUNT(DISTINCT g.league_id || ':' || g.user_id)
     FROM fantasy_gameweek_scores g WHERE g.gameweek = gw.gameweek) AS managers_scored,
  ROUND(
    100.0 * (SELECT COUNT(DISTINCT fl.league_id || ':' || fl.user_id)
               FROM fantasy_lineups fl WHERE fl.gameweek = gw.gameweek)
      / NULLIF((SELECT COUNT(*) FROM fantasy_league_members m
                  JOIN fantasy_leagues l ON l.id = m.league_id
                 WHERE l.draft_status = 'complete'), 0),
    1
  ) AS pct_set_lineup
FROM (
  SELECT DISTINCT gameweek FROM fantasy_gameweek_scores
  UNION SELECT DISTINCT gameweek FROM fantasy_lineups
  UNION SELECT DISTINCT gameweek FROM fantasy_waivers
) AS gw
ORDER BY gw.gameweek;
