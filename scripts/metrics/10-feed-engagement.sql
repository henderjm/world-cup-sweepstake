-- QUESTION: Is the league feed actually being used, or just written to by the
-- app?
--
-- HOW TO READ: one row per league that has any feed at all. `human_messages`
-- against `system_events` is the whole point: the feed design bets that
-- managers talk BECAUSE the transactions land in the same timeline, so a
-- league with hundreds of system events and zero human messages means that bet
-- is not paying off there. `posting_managers` against the league's seat count
-- says whether the talking is a conversation or one person shouting.
-- `days_active` is the spread between the first and last human message: a
-- league that talked only on draft night is a different outcome from one still
-- talking in November.
SELECT
  l.id AS league_id,
  l.name AS league_name,
  l.draft_status,
  (SELECT COUNT(*) FROM fantasy_league_members m WHERE m.league_id = l.id) AS managers,
  SUM(CASE WHEN c.kind = 'message' THEN 1 ELSE 0 END) AS human_messages,
  SUM(CASE WHEN c.kind = 'system' THEN 1 ELSE 0 END) AS system_events,
  COUNT(DISTINCT CASE WHEN c.kind = 'message' THEN c.user_id END) AS posting_managers,
  (SELECT COUNT(*) FROM fantasy_chat_reactions r
     JOIN fantasy_chat_messages cm ON cm.id = r.message_id
    WHERE cm.league_id = l.id) AS reactions,
  MIN(CASE WHEN c.kind = 'message' THEN c.created_at END) AS first_message_at,
  MAX(CASE WHEN c.kind = 'message' THEN c.created_at END) AS last_message_at,
  ROUND(
    julianday(MAX(CASE WHEN c.kind = 'message' THEN c.created_at END))
      - julianday(MIN(CASE WHEN c.kind = 'message' THEN c.created_at END)),
    1
  ) AS days_active
FROM fantasy_leagues l
JOIN fantasy_chat_messages c ON c.league_id = l.id
GROUP BY l.id, l.name, l.draft_status
ORDER BY human_messages DESC, l.id;
