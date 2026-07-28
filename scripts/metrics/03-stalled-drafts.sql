-- QUESTION: Which drafts are stuck right now, and how far did each one get
-- before it stopped?
--
-- HOW TO READ: one row per league still in 'drafting'. `hours_since_last_pick`
-- is the stall detector: the pick clock is 60 seconds, so anything past an hour
-- or two is not "mid-draft", it is dead and needs a human. `pct_complete`
-- says whether it died at the first pick (a room/connection problem) or three
-- rounds in (attention ran out), which are different bugs with different fixes.
-- `picks_expected` is managers x 15, the squad size from SQUAD_SLOTS in
-- src/fantasy.js; if that constant ever changes, change the 15 here too.
--
-- An empty result is the good outcome: no draft is currently wedged.
SELECT
  l.id AS league_id,
  l.name AS league_name,
  l.created_at AS league_created_at,
  (SELECT COUNT(*) FROM fantasy_league_members m WHERE m.league_id = l.id) AS managers,
  (SELECT COUNT(*) FROM fantasy_draft_picks p WHERE p.league_id = l.id) AS picks_made,
  (SELECT COUNT(*) FROM fantasy_league_members m WHERE m.league_id = l.id) * 15 AS picks_expected,
  ROUND(
    100.0 * (SELECT COUNT(*) FROM fantasy_draft_picks p WHERE p.league_id = l.id)
      / NULLIF((SELECT COUNT(*) FROM fantasy_league_members m WHERE m.league_id = l.id) * 15, 0),
    1
  ) AS pct_complete,
  (SELECT MAX(p.picked_at) FROM fantasy_draft_picks p WHERE p.league_id = l.id) AS last_pick_at,
  ROUND(
    (julianday('now')
      - julianday(COALESCE(
          (SELECT MAX(p.picked_at) FROM fantasy_draft_picks p WHERE p.league_id = l.id),
          l.created_at
        ))
    ) * 24,
    1
  ) AS hours_since_last_pick
FROM fantasy_leagues l
WHERE l.draft_status = 'drafting'
ORDER BY hours_since_last_pick DESC;
