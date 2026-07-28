-- QUESTION: Are managers coming back week over week, in wall-clock time?
--
-- HOW TO READ: one row per ISO week (Monday-based, UTC). `active_managers` is
-- the headline retention number: distinct users who did SOMETHING deliberate
-- in a league that week. The other columns say what they did, so a fall in the
-- headline can be attributed rather than just noticed. `active_leagues` says
-- whether activity is broad or one keen league carrying the chart.
--
-- IMPORTANT, this deliberately does NOT include setting a lineup:
-- fantasy_lineups has no timestamp column at all (see the gaps section of
-- README.md), only a gameweek, so there is no way to place a lineup save in a
-- calendar week. Lineup activity is tracked per gameweek instead, in
-- 08-gameweek-retention.sql. That means this number UNDERSTATES engagement,
-- and it understates it most for exactly the quiet manager who sets an XI and
-- nothing else. Treat it as a floor.
SELECT
  strftime('%Y-W%W', event_at) AS iso_week,
  COUNT(DISTINCT user_id) AS active_managers,
  COUNT(DISTINCT league_id) AS active_leagues,
  SUM(CASE WHEN kind = 'draft_pick' THEN 1 ELSE 0 END) AS draft_picks,
  SUM(CASE WHEN kind = 'waiver_claim' THEN 1 ELSE 0 END) AS waiver_claims,
  SUM(CASE WHEN kind = 'feed_post' THEN 1 ELSE 0 END) AS feed_posts,
  SUM(CASE WHEN kind = 'feed_reaction' THEN 1 ELSE 0 END) AS feed_reactions
FROM (
  SELECT picked_at AS event_at, user_id, league_id, 'draft_pick' AS kind FROM fantasy_draft_picks
  UNION ALL
  SELECT created_at, user_id, league_id, 'waiver_claim' FROM fantasy_waivers
  UNION ALL
  SELECT created_at, user_id, league_id, 'feed_post' FROM fantasy_chat_messages WHERE kind = 'message' AND user_id IS NOT NULL
  UNION ALL
  SELECT r.created_at, r.user_id, c.league_id, 'feed_reaction'
    FROM fantasy_chat_reactions r JOIN fantasy_chat_messages c ON c.id = r.message_id
)
GROUP BY iso_week
ORDER BY iso_week DESC;
