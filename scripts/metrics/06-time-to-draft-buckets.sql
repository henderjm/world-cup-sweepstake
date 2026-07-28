-- QUESTION: What is the SHAPE of time-to-draft, not just the per-league list?
--
-- HOW TO READ: buckets of leagues by how long they took from creation to a
-- completed draft, plus how many never got there. The bucket to grow is
-- `same_day`; `over_a_week` and `never_drafted` are the same problem wearing
-- two hats, because a league that has not drafted in a week almost never does.
--
-- Deliberately buckets rather than an average: with a handful of leagues an
-- average is dominated by one outlier, and SQLite has no median function, so a
-- histogram is both more honest and cheaper than faking a percentile.
SELECT
  SUM(CASE WHEN hours IS NOT NULL AND hours < 24 THEN 1 ELSE 0 END) AS same_day,
  SUM(CASE WHEN hours >= 24 AND hours < 72 THEN 1 ELSE 0 END) AS one_to_three_days,
  SUM(CASE WHEN hours >= 72 AND hours < 168 THEN 1 ELSE 0 END) AS three_to_seven_days,
  SUM(CASE WHEN hours >= 168 THEN 1 ELSE 0 END) AS over_a_week,
  SUM(CASE WHEN hours IS NULL THEN 1 ELSE 0 END) AS never_drafted,
  ROUND(AVG(hours), 1) AS avg_hours_when_drafted,
  ROUND(MIN(hours), 1) AS fastest_hours,
  ROUND(MAX(hours), 1) AS slowest_hours
FROM (
  SELECT
    CASE
      WHEN l.draft_status = 'complete'
        THEN (julianday((SELECT MAX(p.picked_at) FROM fantasy_draft_picks p WHERE p.league_id = l.id))
              - julianday(l.created_at)) * 24
      ELSE NULL
    END AS hours
  FROM fantasy_leagues l
);
