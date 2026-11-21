// The D1 half of the in-season xP blend (see the comment above
// runScheduledFantasyXpBlend in worker.js for what the blend is).
//
// The 31 October 2026 outage is why this lives in its own tested module. The
// player read named historical_xp/historical_basis on fantasy_players, where
// those columns have never existed (they are on fantasy_player_xp). The read
// threw, an outer catch swallowed it, fantasy_xp_state never advanced, and so
// the "nothing new to blend" guard never held: every minute the pass re-summed
// the whole per-match score table (4,922 rows by gameweek 9, growing weekly)
// and failed again, until the free tier's daily read allowance ran out and
// every D1 feature went down with it. Two rules follow:
//   1. Errors are thrown, never swallowed, so runCronPass logs
//      "cron pass failed: xp-blend" instead of failing silently forever.
//   2. A failure backs off for an hour inside the isolate, so a broken blend
//      costs one scan an hour, not one a minute.

import { blendWithCurrentSeason } from "../src/fantasyExpectedPoints.js";

export const XP_BLEND_RETRY_MS = 60 * 60 * 1000;
let failedAt = -Infinity;

export function resetXpBlendBackoff() {
  failedAt = -Infinity;
}

// Blends through `latestCompleted` unless already done. Returns "skipped",
// "backoff" or "blended".
export async function blendXpThrough(env, latestCompleted, now = Date.now()) {
  if (latestCompleted < 1) return "skipped";
  const state = await env.DB.prepare("SELECT last_completed_gameweek FROM fantasy_xp_state WHERE id = 1").first();
  if ((state?.last_completed_gameweek ?? 0) >= latestCompleted) return "skipped";
  if (now - failedAt < XP_BLEND_RETRY_MS) return "backoff";
  try {
    // The cheap read goes first and alone: if it fails, the expensive
    // aggregate below is never paid for.
    const players = (await env.DB.prepare(
      `SELECT p.id, x.historical_xp, x.historical_basis
         FROM fantasy_players p LEFT JOIN fantasy_player_xp x ON x.player_id = p.id
        WHERE p.active = 1`,
    ).all()).results ?? [];
    // Aggregated in SQL rather than row by row: the table is one row per
    // player per MATCH, and blendWithCurrentSeason divides by gameweeks
    // played, so a double gameweek's two matches count as one gameweek
    // (COUNT(DISTINCT gameweek)) while contributing both scores (SUM(points)).
    const scores = (await env.DB.prepare(
      `SELECT player_id, SUM(points) AS points, COUNT(DISTINCT gameweek) AS gameweeks
         FROM fantasy_player_match_scores WHERE gameweek <= ?1 GROUP BY player_id`,
    ).bind(latestCompleted).all()).results ?? [];
    const byPlayer = new Map(scores.map((row) => [row.player_id, row]));

    const CHUNK = 100;
    for (let i = 0; i < players.length; i += CHUNK) {
      await env.DB.batch(players.slice(i, i + CHUNK).map((player) => {
        const row = byPlayer.get(player.id);
        const gameweeksPlayed = row?.gameweeks ?? 0;
        const blended = blendWithCurrentSeason(player.historical_xp, row?.points ?? 0, gameweeksPlayed);
        const basis = gameweeksPlayed > 0 ? "blended" : player.historical_basis;
        return env.DB.prepare(
          "UPDATE fantasy_player_xp SET xp = ?2, xp_basis = ?3, updated_at = datetime('now') WHERE player_id = ?1",
        ).bind(player.id, blended, basis);
      }));
    }

    await env.DB.prepare(
      `INSERT INTO fantasy_xp_state (id, last_completed_gameweek, updated_at) VALUES (1, ?1, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET last_completed_gameweek = ?1, updated_at = datetime('now')`,
    ).bind(latestCompleted).run();
    return "blended";
  } catch (error) {
    failedAt = now;
    throw error;
  }
}
