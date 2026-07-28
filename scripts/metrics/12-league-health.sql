-- QUESTION: For each running league, is the machinery behind it actually
-- working?
--
-- HOW TO READ: one row per drafted league. This is the operational companion
-- to the funnel queries: a league can look converted in 01 and still be
-- quietly broken here. `gameweeks_scored` should climb by one per real
-- gameweek; if it is stuck, scoring has stopped and nobody will have said so.
-- `h2h_played` against `h2h_scheduled` shows the head-to-head season actually
-- resolving. `recaps_generated` should track `gameweeks_scored` closely,
-- because the recap is the weekly reason to come back; a gap means the recap
-- cron is failing for that league.
--
-- `last_activity_at` is the freshest wall-clock timestamp available for the
-- league across picks, claims, acquisitions and feed posts, so it is a single
-- "is this league still alive" glance. It cannot see lineup saves, which carry
-- no timestamp (see the gaps section of README.md).
SELECT
  l.id AS league_id,
  l.name AS league_name,
  (SELECT COUNT(*) FROM fantasy_league_members m WHERE m.league_id = l.id) AS managers,
  (SELECT COUNT(DISTINCT g.gameweek) FROM fantasy_gameweek_scores g WHERE g.league_id = l.id) AS gameweeks_scored,
  (SELECT COUNT(*) FROM fantasy_h2h_fixtures f WHERE f.league_id = l.id) AS h2h_scheduled,
  (SELECT COUNT(*) FROM fantasy_h2h_fixtures f WHERE f.league_id = l.id AND f.home_score IS NOT NULL) AS h2h_played,
  (SELECT COUNT(*) FROM fantasy_league_recaps rc WHERE rc.league_id = l.id) AS recaps_generated,
  (SELECT COUNT(*) FROM fantasy_rosters r WHERE r.league_id = l.id AND r.acquired_via <> 'draft') AS post_draft_moves,
  MAX(
    COALESCE((SELECT MAX(p.picked_at) FROM fantasy_draft_picks p WHERE p.league_id = l.id), l.created_at),
    COALESCE((SELECT MAX(w.created_at) FROM fantasy_waivers w WHERE w.league_id = l.id), l.created_at),
    COALESCE((SELECT MAX(r.acquired_at) FROM fantasy_rosters r WHERE r.league_id = l.id), l.created_at),
    COALESCE((SELECT MAX(c.created_at) FROM fantasy_chat_messages c WHERE c.league_id = l.id AND c.kind = 'message'), l.created_at)
  ) AS last_activity_at
FROM fantasy_leagues l
WHERE l.draft_status = 'complete'
ORDER BY last_activity_at DESC;
