// Season leaderboards for the V2 league page (Stats tab): top scorers, top
// assists and most yellow cards, from Sportmonks' season topscorers endpoint.
// Pure and shared by the Worker (mapping) and the tests. A leaderboard
// Sportmonks did not return is absent, never an empty list drawn as "nobody".

import { COMPETITIONS } from "./competitions.js";
import { SPORTMONKS_LEAGUES } from "./sportmonks.js";
import { normalizeTeamName } from "./domain.js";

// Sportmonks topscorer type ids.
export const TOPSCORER_CATEGORIES = [
  { key: "goals", label: "Goals", typeId: 208 },
  { key: "assists", label: "Assists", typeId: 209 },
  { key: "yellowCards", label: "Yellow cards", typeId: 84 },
];

export const TOPSCORER_LIMIT = 20;

// The Sportmonks league id for a competition the app covers, or null.
export function sportmonksLeagueFor(code) {
  return COMPETITIONS[code]?.sportmonksLeagueId ?? SPORTMONKS_LEAGUES[code] ?? null;
}

// One leaderboard: rows sorted by Sportmonks' own position (ties keep their
// shared position), capped, each row only what the page draws.
export function mapTopscorers(rows, limit = TOPSCORER_LIMIT) {
  return (rows ?? [])
    .filter(row => Number.isFinite(Number(row?.total)) && row?.player_id)
    .map(row => ({
      playerId: row.player_id,
      name: row.player?.display_name ?? row.player?.common_name ?? row.player?.name ?? "",
      image: row.player?.image_path ?? null,
      team: row.participant?.name ? normalizeTeamName(row.participant.name) : null,
      teamImage: row.participant?.image_path ?? null,
      total: Number(row.total),
      position: Number.isFinite(Number(row.position)) ? Number(row.position) : null,
    }))
    .filter(row => row.name)
    .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || b.total - a.total || a.name.localeCompare(b.name))
    .slice(0, limit);
}
