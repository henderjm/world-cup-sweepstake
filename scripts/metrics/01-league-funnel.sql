-- QUESTION: What does the whole league funnel look like, in one row?
--
-- HOW TO READ: every column is a count of LEAGUES, and the stages are nested
-- (a league counted in `draft_completed` is also counted in `draft_started`).
-- So the interesting number is never a column, it is the DROP between two
-- adjacent columns. `leagues_created` to `reached_two_managers` is the invite
-- problem; `reached_two_managers` to `draft_started` is the scheduling
-- problem; `draft_started` to `draft_completed` is the stall (see
-- 03-stalled-drafts.sql for which ones); `draft_completed` to
-- `scored_two_gameweeks` is whether the league actually became a habit.
--
-- A league is counted as having started a draft if its status ever moved off
-- 'pending' OR it has at least one pick, rather than picks alone, so a draft
-- that opened and stalled before anybody picked still counts as an attempt.
SELECT
  COUNT(*) AS leagues_created,
  SUM(CASE WHEN member_count >= 2 THEN 1 ELSE 0 END) AS reached_two_managers,
  SUM(CASE WHEN draft_status IN ('drafting', 'complete') OR pick_count > 0 THEN 1 ELSE 0 END) AS draft_started,
  SUM(CASE WHEN draft_status = 'complete' THEN 1 ELSE 0 END) AS draft_completed,
  SUM(CASE WHEN draft_status = 'complete' AND scored_gameweeks >= 1 THEN 1 ELSE 0 END) AS scored_1_gameweek,
  SUM(CASE WHEN draft_status = 'complete' AND scored_gameweeks >= 2 THEN 1 ELSE 0 END) AS scored_2_gameweeks,
  SUM(CASE WHEN draft_status = 'complete' AND scored_gameweeks >= 4 THEN 1 ELSE 0 END) AS scored_4_gameweeks
FROM (
  SELECT
    l.draft_status,
    (SELECT COUNT(*) FROM fantasy_league_members m WHERE m.league_id = l.id) AS member_count,
    (SELECT COUNT(*) FROM fantasy_draft_picks p WHERE p.league_id = l.id) AS pick_count,
    (SELECT COUNT(DISTINCT g.gameweek) FROM fantasy_gameweek_scores g WHERE g.league_id = l.id) AS scored_gameweeks
  FROM fantasy_leagues l
);
