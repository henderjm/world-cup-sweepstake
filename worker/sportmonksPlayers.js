// GET /player/:id/season/:season: one player's season figures for the V2
// player sheet. Public, so it only answers for the CURRENT season of a
// competition the app covers: anything else would let a caller spend the
// Sportmonks Player allowance on arbitrary players and years. Spending goes
// through worker/sportmonksClient.js (memo, allowance floor, header key).

import { compactDetails } from "../src/playerStats.js";
import { sportmonks } from "./sportmonksClient.js";

const SEASON_LIST_TTL_MS = 12 * 60 * 60 * 1000;
const PLAYER_TTL_MS = 6 * 60 * 60 * 1000;
// Premier League, Champions League, Serie A, La Liga.
const LEAGUES = [8, 2, 384, 564];

export async function currentSeasonIds(env, now = Date.now()) {
  const ids = new Set();
  for (const league of LEAGUES) {
    try {
      const id = (await sportmonks(env, `/leagues/${league}?include=currentSeason`, SEASON_LIST_TTL_MS, now))?.currentseason?.id;
      if (id) ids.add(id);
    } catch {
      // one league unreadable must not block the others
    }
  }
  return ids;
}

// { available, name, image, position, stats } or { available: false }.
export async function playerSeason(env, playerId, seasonId, now = Date.now()) {
  if (!(await currentSeasonIds(env, now)).has(seasonId)) return { available: false };
  const player = await sportmonks(
    env, `/players/${playerId}?include=statistics.details;position&filters=playerStatisticSeasons:${seasonId}`, PLAYER_TTL_MS, now,
  );
  if (!player) return { available: false };
  // A player who moved mid-season has one entry per club: the season sheet
  // shows the club he has played most minutes for, never a sum of two.
  const minutes = entry => Number(entry.details?.find(detail => detail.type_id === 119)?.value?.total) || 0;
  const entry = [...(player.statistics ?? [])].sort((a, b) => minutes(b) - minutes(a))[0] ?? null;
  return {
    available: true,
    name: player.display_name ?? player.common_name ?? player.name ?? "",
    image: player.image_path ?? null,
    position: player.position?.name ?? null,
    stats: entry ? compactDetails(entry.details) : {},
  };
}
