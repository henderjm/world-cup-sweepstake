-- QUESTION: How many managers are in each drafted league, and how many of
-- those seats are actually alive?
--
-- HOW TO READ: one row per league whose draft completed. `managers` is the
-- seat count. The three activity columns are what separates a real manager
-- from a warm body: `set_a_lineup` explicitly saved an XI at least once,
-- `made_a_claim` touched waivers or free agency, `posted_in_feed` wrote a
-- human message. `dormant_seats` did NONE of the three after the draft, which
-- is the closest this schema can get to "an empty seat" (see the caveat below).
-- A drafted league whose dormant_seats equals its managers is a league that
-- drafted and then died, and it should not be counted as a success anywhere.
--
-- CAVEAT, read before quoting these numbers: the schema has no notion of a bot
-- or a reserved seat. Every row in fantasy_league_members is a real signed-in
-- Google account, and there is no target-size column on fantasy_leagues, so
-- "unfilled seats" is not a question this data can answer at all. Dormancy is
-- the honest substitute. Note also that a manager who never sets a lineup is
-- not necessarily absent: an unset lineup INHERITS the previous gameweek's XI
-- by design (see resolveEffectiveLineup in src/fantasyLineups.js), so a happy
-- manager with a settled squad can legitimately never write a row. Read
-- `set_a_lineup` as a floor on engagement, never as attendance.
SELECT
  l.id AS league_id,
  l.name AS league_name,
  COUNT(m.user_id) AS managers,
  SUM(CASE WHEN EXISTS (
        SELECT 1 FROM fantasy_lineups fl WHERE fl.league_id = l.id AND fl.user_id = m.user_id
      ) THEN 1 ELSE 0 END) AS set_a_lineup,
  SUM(CASE WHEN EXISTS (
        SELECT 1 FROM fantasy_waivers w WHERE w.league_id = l.id AND w.user_id = m.user_id
      ) THEN 1 ELSE 0 END) AS made_a_claim,
  SUM(CASE WHEN EXISTS (
        SELECT 1 FROM fantasy_chat_messages c
        WHERE c.league_id = l.id AND c.user_id = m.user_id AND c.kind = 'message'
      ) THEN 1 ELSE 0 END) AS posted_in_feed,
  SUM(CASE WHEN NOT EXISTS (
        SELECT 1 FROM fantasy_lineups fl WHERE fl.league_id = l.id AND fl.user_id = m.user_id
      ) AND NOT EXISTS (
        SELECT 1 FROM fantasy_waivers w WHERE w.league_id = l.id AND w.user_id = m.user_id
      ) AND NOT EXISTS (
        SELECT 1 FROM fantasy_chat_messages c
        WHERE c.league_id = l.id AND c.user_id = m.user_id AND c.kind = 'message'
      ) THEN 1 ELSE 0 END) AS dormant_seats
FROM fantasy_leagues l
JOIN fantasy_league_members m ON m.league_id = l.id
WHERE l.draft_status = 'complete'
GROUP BY l.id, l.name
ORDER BY l.id;
