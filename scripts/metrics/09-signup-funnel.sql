-- QUESTION: Of everyone who signed in, how many got all the way to playing?
--
-- HOW TO READ: the league funnel (01) counts leagues; this counts PEOPLE, and
-- the two answer different questions. Columns are nested the same way, so read
-- the drops. `signed_up` to `joined_a_league` is whether sign-in leads
-- anywhere at all. `in_a_drafted_league` to `active_after_draft` is the one
-- that decides whether this is a product or a one-night novelty.
--
-- `active_after_draft` means the manager did something deliberate after their
-- draft: saved an XI, filed a claim, or posted in the feed. Because an unset
-- lineup legitimately inherits the previous gameweek's, this undercounts
-- quiet-but-present managers; it is a floor, not a census.
--
-- `returned_after_first_day` uses the sessions table: a session row is written
-- per sign-in, so more than one calendar day of sessions means the person came
-- back to the site at all, independent of anything they did in a league.
-- Sessions expire after 30 days and are pruned, so this figure only sees the
-- recent window rather than all history.
SELECT
  COUNT(*) AS signed_up,
  SUM(CASE WHEN league_count > 0 THEN 1 ELSE 0 END) AS joined_a_league,
  SUM(CASE WHEN drafted_league_count > 0 THEN 1 ELSE 0 END) AS in_a_drafted_league,
  SUM(CASE WHEN pick_count > 0 THEN 1 ELSE 0 END) AS made_a_draft_pick,
  SUM(CASE WHEN drafted_league_count > 0 AND (lineup_count > 0 OR claim_count > 0 OR post_count > 0) THEN 1 ELSE 0 END) AS active_after_draft,
  SUM(CASE WHEN session_days > 1 THEN 1 ELSE 0 END) AS returned_after_first_day
FROM (
  SELECT
    u.id,
    (SELECT COUNT(*) FROM fantasy_league_members m WHERE m.user_id = u.id) AS league_count,
    (SELECT COUNT(*) FROM fantasy_league_members m JOIN fantasy_leagues l ON l.id = m.league_id
      WHERE m.user_id = u.id AND l.draft_status = 'complete') AS drafted_league_count,
    (SELECT COUNT(*) FROM fantasy_draft_picks p WHERE p.user_id = u.id) AS pick_count,
    (SELECT COUNT(*) FROM fantasy_lineups fl WHERE fl.user_id = u.id) AS lineup_count,
    (SELECT COUNT(*) FROM fantasy_waivers w WHERE w.user_id = u.id) AS claim_count,
    (SELECT COUNT(*) FROM fantasy_chat_messages c WHERE c.user_id = u.id AND c.kind = 'message') AS post_count,
    (SELECT COUNT(DISTINCT date(s.created_at)) FROM sessions s WHERE s.user_id = u.id) AS session_days
  FROM users u
);
