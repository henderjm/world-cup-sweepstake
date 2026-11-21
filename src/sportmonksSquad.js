// One club's season player stats for the club sheet's Players tab, from
// Sportmonks' season squad with each player's season statistics. Pure and
// shared by the Worker (mapping) and the browser (sorting). A figure
// Sportmonks did not send is absent, never drawn as 0.

import { normalizeTeamName } from "./domain.js";
import { compactDetails } from "./playerStats.js";

const POSITION = { 24: "G", 25: "D", 26: "M", 27: "F" };

// Season detail type ids (verified on Inter, Serie A 2026/27).
export const CLUB_STAT_SORTS = [
  { key: "goals", label: "Goals", typeId: 52 },
  { key: "assists", label: "Assists", typeId: 79 },
  { key: "apps", label: "Apps", typeId: 321 },
  { key: "minutes", label: "Minutes", typeId: 119 },
  { key: "rating", label: "Rating", typeId: 118, decimals: 2 },
  { key: "xg", label: "xG", typeId: 5304, decimals: 2 },
  { key: "yellow", label: "Yellow cards", typeId: 84 },
];
const T = Object.fromEntries(CLUB_STAT_SORTS.map(sort => [sort.key, sort.typeId]));

// The Sportmonks team id for an app club name in a season's standings, or
// null unless exactly one participant matches (a wrong join would show
// another club's players).
export function findParticipantId(standings, team) {
  const want = normalizeTeamName(team);
  if (!want) return null;
  const ids = new Set((standings ?? [])
    .filter(row => normalizeTeamName(row.participant?.name) === want)
    .map(row => row.participant_id ?? row.participant?.id)
    .filter(Boolean));
  return ids.size === 1 ? [...ids][0] : null;
}

// [{ playerId, name, image, pos, num, stats }] for one squad. `stats` is
// keyed by type id like the player sheet's, so a row can open it directly.
export function mapSquadStats(rows, seasonId) {
  return (rows ?? [])
    .map(row => {
      const player = row.player ?? {};
      const season = (player.statistics ?? []).find(entry => entry.season_id === seasonId && entry.team_id === row.team_id)
        ?? (player.statistics ?? []).find(entry => entry.season_id === seasonId);
      return {
        playerId: row.player_id ?? player.id ?? null,
        name: String(player.display_name ?? player.common_name ?? player.name ?? "").trim(),
        image: player.image_path ?? null,
        pos: POSITION[row.position_id ?? player.position_id] ?? null,
        num: row.jersey_number ?? null,
        stats: compactDetails(season?.details),
      };
    })
    .filter(player => player.playerId && player.name);
}

// The squad ranked by one stat, highest first; players without that figure
// are left out rather than ranked as 0. Rating only counts a player with
// at least `minApps` appearances, so one cameo cannot top the club.
export function clubLeaderboard(players, key, { minApps = 3 } = {}) {
  const typeId = T[key];
  if (!typeId) return [];
  return (players ?? [])
    .filter(player => Number.isFinite(player.stats?.[typeId]))
    .filter(player => key !== "rating" || (player.stats[T.apps] ?? 0) >= minApps)
    .map(player => ({ ...player, value: player.stats[typeId] }))
    .sort((a, b) => b.value - a.value || (b.stats[T.minutes] ?? 0) - (a.stats[T.minutes] ?? 0) || a.name.localeCompare(b.name));
}

// "12 apps · 980'" under a player's name, from whatever was sent.
export function squadLine(player) {
  const apps = player.stats?.[T.apps];
  const minutes = player.stats?.[T.minutes];
  return [Number.isFinite(apps) ? `${apps} apps` : null, Number.isFinite(minutes) ? `${minutes}'` : null].filter(Boolean).join(" · ");
}

export function formatStat(key, value) {
  const sort = CLUB_STAT_SORTS.find(entry => entry.key === key);
  return sort?.decimals ? Number(value).toFixed(sort.decimals) : String(value);
}
