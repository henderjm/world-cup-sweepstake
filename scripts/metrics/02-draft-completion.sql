-- QUESTION: Of the leagues that started a draft, how many finished it?
--
-- HOW TO READ: `completion_pct` is the headline. A draft that stalls is the
-- failure mode that has already burned two real attempts, so this is the
-- number to watch move. `drafts_open_now` is the live count of drafts sitting
-- in 'drafting' right now: some of those are genuinely mid-draft rather than
-- dead, which is why 03-stalled-drafts.sql exists to age them.
--
-- Denominator matches 01-league-funnel.sql's `draft_started` exactly.
SELECT
  COUNT(*) AS drafts_started,
  SUM(CASE WHEN l.draft_status = 'complete' THEN 1 ELSE 0 END) AS drafts_completed,
  SUM(CASE WHEN l.draft_status = 'drafting' THEN 1 ELSE 0 END) AS drafts_open_now,
  ROUND(
    100.0 * SUM(CASE WHEN l.draft_status = 'complete' THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0),
    1
  ) AS completion_pct
FROM fantasy_leagues l
WHERE l.draft_status IN ('drafting', 'complete')
   OR EXISTS (SELECT 1 FROM fantasy_draft_picks p WHERE p.league_id = l.id);
