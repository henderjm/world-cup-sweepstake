// Pure logic for the fantasy draft pool's likely-first-teamer signal. Season
// appearance data alone tells us nothing without a rule for turning it into an
// ordering; that rule lives here, isolated from the fetch script, so it is
// fixture-testable without an API-Football key.
//
// Why a previous-season proxy: a brand-new season's appearance data is all
// zeros until matches are actually played, which is useless as a "does this
// player actually play" signal in preseason. The previous completed season's
// minutes are the best available proxy, so `previousSeasonFor` derives it from
// whatever season the rest of the fetch is already using rather than a
// hardcoded year, and stays correct as seasons roll forward.

import { normalizeTeamName } from "./domain.js";
import { normalizeSeasonLine } from "./fantasyExpectedPoints.js";

// Roughly ten full matches: enough to call someone an established starter
// without requiring an implausible ever-present season.
const STARTER_MINUTES_THRESHOLD = 900;

// Ordering used to sort the pool. A missing prior-season record ("unknown")
// ranks above "fringe" on purpose: a zero-minutes record is *evidence* a
// player didn't play, while no record at all is simply no evidence either
// way (a new signing, a promoted club's player, a genuine academy prospect).
// Treating "no evidence" as worse than "evidence of not playing" would bury
// good new signings, which is exactly the failure mode we're avoiding.
export const TIER_ORDER = ["starter", "squad", "unknown", "fringe"];
const TIER_RANK = Object.fromEntries(TIER_ORDER.map((tier, index) => [tier, index]));

// Given the previous season's { appearances, minutes } for a player (or
// null/undefined when no record was found at all), derive a coarse tier:
//   - "unknown": no prior-season record exists. Not a judgement, just a gap.
//   - "starter": played substantial minutes last season, a likely first-teamer.
//   - "squad": has some prior-season minutes/appearances, but below the
//     starter threshold, e.g. a rotation option or a squad player who
//     started to break through.
//   - "fringe": has a prior-season record but zero recorded minutes, e.g. a
//     third-choice keeper who was registered all season but never played.
export function deriveTier(stat) {
  if (stat == null) return "unknown";
  const minutes = Number(stat.minutes) || 0;
  const appearances = Number(stat.appearances) || 0;
  if (minutes >= STARTER_MINUTES_THRESHOLD) return "starter";
  if (minutes > 0 || appearances > 0) return "squad";
  return "fringe";
}

// Derives the previous-season identifier from whatever season string/number
// the rest of the fetch is configured with (API-Football seasons are named by
// their starting year), rather than a hardcoded guess that would go stale.
export function previousSeasonFor(season) {
  const year = Number(season);
  if (!Number.isInteger(year)) throw new Error(`invalid season: ${season}`);
  return String(year - 1);
}

// Walks previousSeasonFor back `count` times, most recent first: for the
// current season 2026 and count 3, ["2025", "2024", "2023"]. Used by the
// multi-season xP baseline (src/fantasyExpectedPoints.js's SEASON_WEIGHTS,
// most recent first), which needs several completed seasons rather than the
// single one the tier signal above still uses.
export function previousSeasonsFor(season, count = 3) {
  const seasons = [];
  let current = String(season);
  for (let i = 0; i < count; i++) {
    current = previousSeasonFor(current);
    seasons.push(current);
  }
  return seasons;
}

// Stable-sorts a player pool so likely first-teamers surface first. Safe to
// call even when no player carries a `tier` (the pre-enrichment/degraded
// shape): every entry then ranks equally and the original order is preserved,
// since Array#sort is a stable sort.
export function sortPlayerPool(players) {
  return [...(players ?? [])].sort((a, b) => (TIER_RANK[a?.tier] ?? 0) - (TIER_RANK[b?.tier] ?? 0));
}

// Parses the raw API-Football /players payload pages (each `{ response: [...] }`,
// as returned by the Go CLI) into a Map<playerId, line>, where `line` is a full
// normalizeSeasonLine-shaped season total (appearances, minutes, goals, assists,
// cards, ...), summing across any repeated rows for the same player (a
// mid-season transfer can produce one row per club) and across duplicate rows
// across pages. Filtered to the requested league id defensively, even though
// the upstream query already scopes to one league, in case a player's
// statistics entry carries a different competition (API-Football's
// `statistics` array is not contractually guaranteed to be pre-filtered).
//
// The returned line still carries `appearances`/`minutes` at the top level, so
// deriveTier (below) keeps working unchanged; the extra goals/assists/cards
// fields are what scripts/fetch-fantasy-players.mjs feeds to
// src/fantasyExpectedPoints.js's expectedPointsFor as one season of history.
const EMPTY_SEASON_LINE = () => ({
  appearances: 0,
  lineups: 0,
  minutes: 0,
  goals: 0,
  assists: 0,
  conceded: 0,
  yellow: 0,
  yellowRed: 0,
  red: 0,
  ownGoals: 0,
});

export function buildPriorSeasonStatsIndex(pages, leagueId) {
  const index = new Map();
  for (const page of pages ?? []) {
    for (const entry of page?.response ?? []) {
      const id = entry?.player?.id;
      if (id == null) continue;
      const statistics = (entry.statistics ?? []).filter((row) => row?.league?.id === leagueId);
      if (!statistics.length) continue;
      const line = index.get(id) ?? EMPTY_SEASON_LINE();
      for (const row of statistics) {
        const normalized = normalizeSeasonLine(row);
        if (!normalized) continue;
        for (const key of Object.keys(line)) line[key] += normalized[key] ?? 0;
      }
      index.set(id, line);
    }
  }
  return index;
}

// Per-player, per-club appearance breakdown for one season's league-scoped
// statistics rows: Map<playerId, Map<clubName, appearances>>. Used only to
// weight a transferred player's clean-sheet rate across every club they
// actually turned out for that season (see
// src/fantasyExpectedPoints.js's weightedCleanSheetRate) rather than
// attributing the whole season to one club arbitrarily.
//
// Club names are run through normalizeTeamName here, same as
// mapApiFootballMatches does for the fixtures feed clubCleanSheetRates reads:
// API-Football's /players endpoint and its /fixtures endpoint spell some clubs
// differently ("Coventry" vs "Coventry City"), and without normalizing both
// sides the join silently returns a 0 rate for every promoted club's players.
export function buildPlayerClubAppearances(pages, leagueId) {
  const index = new Map();
  for (const page of pages ?? []) {
    for (const entry of page?.response ?? []) {
      const id = entry?.player?.id;
      if (id == null) continue;
      for (const row of entry.statistics ?? []) {
        if (row?.league?.id !== leagueId) continue;
        const appearances = Number(row.games?.appearences ?? row.games?.appearances) || 0;
        const club = row.team?.name ? normalizeTeamName(row.team.name) : null;
        if (!club || appearances <= 0) continue;
        const byClub = index.get(id) ?? new Map();
        byClub.set(club, (byClub.get(club) ?? 0) + appearances);
        index.set(id, byClub);
      }
    }
  }
  return index;
}
