-- QUESTION: When a draft happened, was anybody actually there? Per league, how
-- many of its HUMAN picks were made at the keyboard, how many fell to the clock,
-- and how many managers slept through the whole thing.
--
-- HOW TO READ: `engaged_pct` is the headline, and it is the difference between
-- knowing a draft completed and knowing it worked. A league at 100 drafted
-- properly. A league at 20 technically has a full set of squads and nobody had
-- an experience worth telling a friend about, which is the failure this column
-- exists to make visible.
--
-- The four `via` values (see PICK_VIA in src/draftLogic.js):
--   manual    somebody sent the pick. Present.
--   queue     their clock expired but their own shortlist supplied the pick.
--             Prepared, not present. Counted as engaged, and separated out so
--             it can be moved to the other side of the line if that reading
--             ever turns out to be too generous.
--   autopick  their clock expired with nothing legal queued. Nobody chose this
--             player.
--   bot       a bot seat. EXCLUDED from every percentage here, deliberately: a
--             bot's clock always expires by design, so counting it would make
--             a bot-filled league read as a league full of absentees and would
--             drag the one number this file exists for straight down.
--
-- `unknown_picks` is picks written before the `via` column existed
-- (worker/migrations/004-draft-pick-via.sql adds it with no backfill, on
-- purpose). They are reported rather than assumed: a league with any of these
-- has an `engaged_pct` computed over only part of its board, so read
-- `human_picks` as the real denominator and treat a league that is mostly
-- unknown as unmeasured, not as bad.
--
-- `sleepwalkers` counts managers whose EVERY human pick was a generic autopick.
-- One of these in a league is the abandoned team that ruins the season for
-- everybody else, and it is worth finding before the season starts rather than
-- in November.
SELECT
  l.id AS league_id,
  l.name AS league_name,
  COUNT(p.id) AS total_picks,
  SUM(CASE WHEN p.via = 'bot' THEN 1 ELSE 0 END) AS bot_picks,
  SUM(CASE WHEN p.via IS NULL THEN 1 ELSE 0 END) AS unknown_picks,
  SUM(CASE WHEN p.via IN ('manual', 'queue', 'autopick') THEN 1 ELSE 0 END) AS human_picks,
  SUM(CASE WHEN p.via = 'manual' THEN 1 ELSE 0 END) AS manual_picks,
  SUM(CASE WHEN p.via = 'queue' THEN 1 ELSE 0 END) AS queue_picks,
  SUM(CASE WHEN p.via = 'autopick' THEN 1 ELSE 0 END) AS autopick_picks,
  ROUND(
    100.0 * SUM(CASE WHEN p.via IN ('manual', 'queue') THEN 1 ELSE 0 END)
      / NULLIF(SUM(CASE WHEN p.via IN ('manual', 'queue', 'autopick') THEN 1 ELSE 0 END), 0),
    1
  ) AS engaged_pct,
  (
    SELECT COUNT(*)
    FROM (
      SELECT p2.user_id
      FROM fantasy_draft_picks p2
      JOIN users u2 ON u2.id = p2.user_id
      WHERE p2.league_id = l.id AND u2.is_bot = 0 AND p2.via IS NOT NULL
      GROUP BY p2.user_id
      HAVING SUM(CASE WHEN p2.via IN ('manual', 'queue') THEN 1 ELSE 0 END) = 0
    )
  ) AS sleepwalkers
FROM fantasy_leagues l
JOIN fantasy_draft_picks p ON p.league_id = l.id
GROUP BY l.id, l.name
ORDER BY engaged_pct IS NULL, engaged_pct ASC, l.id;
