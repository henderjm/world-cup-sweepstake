-- QUESTION: How long does a league take to go from created to drafted?
--
-- HOW TO READ: one row per league that completed a draft, newest first. This
-- is the single best conversion measure the product has: a league that drafts
-- the same evening it was created has converted, and a league still waiting a
-- week later usually never drafts at all. Watch the trend in
-- `hours_created_to_drafted`, not any one row.
--
-- `drafted_at` is the LAST pick's timestamp rather than a completion column,
-- because fantasy_leagues records only a draft_status and no completed_at (see
-- the gaps section of README.md). The final pick and completeDraft() run in
-- the same commit path in worker/draftRoom.js, so the last pick is accurate to
-- within a second of the real completion.
--
-- `hours_first_to_last_pick` is the draft ITSELF, separated out from the wait
-- before it, because they fail for completely different reasons: a long wait
-- is a scheduling problem, a long draft is an attention problem.
SELECT
  l.id AS league_id,
  l.name AS league_name,
  (SELECT COUNT(*) FROM fantasy_league_members m WHERE m.league_id = l.id) AS managers,
  l.created_at AS league_created_at,
  MIN(p.picked_at) AS first_pick_at,
  MAX(p.picked_at) AS drafted_at,
  ROUND((julianday(MAX(p.picked_at)) - julianday(l.created_at)) * 24, 1) AS hours_created_to_drafted,
  ROUND((julianday(MIN(p.picked_at)) - julianday(l.created_at)) * 24, 1) AS hours_created_to_first_pick,
  ROUND((julianday(MAX(p.picked_at)) - julianday(MIN(p.picked_at))) * 24, 2) AS hours_first_to_last_pick
FROM fantasy_leagues l
JOIN fantasy_draft_picks p ON p.league_id = l.id
WHERE l.draft_status = 'complete'
GROUP BY l.id, l.name, l.created_at
ORDER BY drafted_at DESC;
