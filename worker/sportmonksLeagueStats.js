// GET /:comp/stats: season leaderboards (goals, assists, yellow cards) for the
// V2 league page, from Sportmonks' season topscorers. Public, so it only ever
// answers for the CURRENT season of a competition the app covers; the season
// id is resolved server-side and never taken from the caller. Spending goes
// through worker/sportmonksClient.js (memo, allowance floor, header key).
//
// One call per leaderboard, each filtered to its own type, so a busy type
// cannot crowd another off the first page. Leaderboards move only when a
// match finishes, so an hour's memo is plenty.

import { TOPSCORER_CATEGORIES, mapTopscorers, sportmonksLeagueFor } from "../src/sportmonksTopscorers.js";
import { sportmonks, sportmonksBody } from "./sportmonksClient.js";

const SEASON_TTL_MS = 12 * 60 * 60 * 1000;
const STATS_TTL_MS = 60 * 60 * 1000;

export async function currentSeasonId(env, league, now = Date.now()) {
  return (await sportmonks(env, `/leagues/${league}?include=currentSeason`, SEASON_TTL_MS, now))?.currentseason?.id ?? null;
}

// { available, seasonId, fetchedAt, categories: [{ key, label, rows }] } or
// { available: false }. One leaderboard failing leaves the others standing.
export async function leagueStats(env, code, now = Date.now()) {
  const league = sportmonksLeagueFor(code);
  if (!league) return { available: false };
  const seasonId = await currentSeasonId(env, league, now);
  if (!seasonId) return { available: false };
  let fetchedAt = now;
  const categories = [];
  for (const category of TOPSCORER_CATEGORIES) {
    try {
      const entry = await sportmonksBody(
        env,
        `/topscorers/seasons/${seasonId}?include=player;participant&filters=seasonTopscorerTypes:${category.typeId}&per_page=50`,
        STATS_TTL_MS,
        now,
      );
      fetchedAt = Math.min(fetchedAt, entry.fetchedAt);
      const rows = mapTopscorers(entry.body.data);
      if (rows.length) categories.push({ key: category.key, label: category.label, rows });
    } catch {
      // one leaderboard unreadable must not blank the others
    }
  }
  if (!categories.length) return { available: false };
  return { available: true, seasonId, fetchedAt: new Date(fetchedAt).toISOString(), categories };
}
