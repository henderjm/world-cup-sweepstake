-- QUESTION: Where do the people who sign up come from, and which source
-- produces managers rather than sign-ups?
--
-- HOW TO READ: one row per acquisition source, worst first by volume. The
-- columns are the people funnel (09) cut by `users.signup_source`, so read
-- the DROPS within a row: a source with many `signed_up` and few
-- `joined_a_league` is paying for tourists. `unknown` is everyone who signed up
-- before attribution existed (NULL, never backfilled) plus anyone whose browser
-- blocked storage; it is not a channel.
--
-- Sources are what src/attribution.js derives: a utm_source when the landing
-- URL carried one (paid campaigns, tagged posts), `invite` for a shared league
-- link, `learn` for a visitor who read a pre-rendered Learn page first, a named
-- referrer (google, reddit, x, facebook, ...) or the referring host, else
-- `direct`. `signup_campaign` is only ever set from utm_campaign, so the
-- campaign column separates two ads on the same platform.
--
-- Cost per sign-up is this row's `signed_up` against what that campaign spent;
-- spend is not in the database and never will be.
SELECT
  COALESCE(u.signup_source, 'unknown') AS source,
  COALESCE(u.signup_medium, '') AS medium,
  COALESCE(u.signup_campaign, '') AS campaign,
  COUNT(*) AS signed_up,
  SUM(CASE WHEN league_count > 0 THEN 1 ELSE 0 END) AS joined_a_league,
  SUM(CASE WHEN drafted_league_count > 0 THEN 1 ELSE 0 END) AS in_a_drafted_league,
  SUM(CASE WHEN session_days > 1 THEN 1 ELSE 0 END) AS returned_after_first_day,
  MIN(u.created_at) AS first_signup_at,
  MAX(u.created_at) AS last_signup_at
FROM (
  SELECT
    u.id,
    u.created_at,
    u.signup_source,
    u.signup_medium,
    u.signup_campaign,
    (SELECT COUNT(*) FROM fantasy_league_members m WHERE m.user_id = u.id) AS league_count,
    (SELECT COUNT(*) FROM fantasy_league_members m JOIN fantasy_leagues l ON l.id = m.league_id
      WHERE m.user_id = u.id AND l.draft_status = 'complete') AS drafted_league_count,
    (SELECT COUNT(DISTINCT date(s.created_at)) FROM sessions s WHERE s.user_id = u.id) AS session_days
  FROM users u
  WHERE u.is_bot = 0
) u
GROUP BY 1, 2, 3
ORDER BY signed_up DESC, source;
