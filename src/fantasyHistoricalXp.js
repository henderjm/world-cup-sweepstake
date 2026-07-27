// Turns already-fetched multi-season index data into a whole player pool's
// tier signal and expected-points figures. Pure: array/Map in, array out, no
// fetch, no D1 - scripts/fetch-fantasy-players.mjs does the network calls
// (paginated /players statistics, /fixtures) and hands this module the
// per-season Maps that buildPriorSeasonStatsIndex/buildPlayerClubAppearances
// (src/fantasyPlayerTier.js) and clubCleanSheetRates
// (src/fantasyExpectedPoints.js) already produce from them.
//
// Neither function here mutates its `players` argument: both return a new
// array, matching the array-in/array-out convention the rest of src/fantasy*.js
// follows, even though the single-season enrichment this replaces used to
// mutate in place.

import { deriveTier } from "./fantasyPlayerTier.js";
import { expectedPointsFor, weightedCleanSheetRate } from "./fantasyExpectedPoints.js";

// Adds appearances/minutes/tier/likelyStarter from exactly the most recent
// completed season - the same single-season "does this player actually play"
// signal the pool has always used (see fantasyPlayerTier.js), unaffected by
// however many seasons the xP baseline below draws on. `mostRecentSeason` is
// one entry of the `perSeason` array enrichPoolWithHistoricalXp takes: `{
// season, statsIndex }` (statsIndex may be null if that season's stats fetch
// failed). A null/missing statsIndex returns `players` untouched and
// `{ available: false }`, exactly like today's "no enrichment at all" degrade
// (see hasPriorSeasonData in fantasyDraft.js, which checks for the absence of
// `tier` rather than trusting this header).
export function deriveTiersFromSeason(players, mostRecentSeason) {
  const statsIndex = mostRecentSeason?.statsIndex ?? null;
  if (!statsIndex) {
    return { players: players ?? [], header: { available: false, season: null, playersWithoutRecord: null } };
  }

  let playersWithoutRecord = 0;
  const enriched = (players ?? []).map((player) => {
    const stat = statsIndex.get(player.id) ?? null;
    if (!stat) playersWithoutRecord += 1;
    const tier = deriveTier(stat);
    return {
      ...player,
      appearances: stat ? stat.appearances : null,
      minutes: stat ? stat.minutes : null,
      tier,
      likelyStarter: tier === "starter",
    };
  });
  return { players: enriched, header: { available: true, season: mostRecentSeason.season, playersWithoutRecord } };
}

// Computes each player's xp/xpBasis from up to three completed seasons of
// history (most recent first, matching SEASON_WEIGHTS), falling back to a
// same-position/tier cohort median (baselineFromCohort) for anyone with no
// usable history at all. Two passes over the pool:
//   1. Score every player against their own real history only. No cohort yet
//      - a cohort built from a still-incomplete first pass would just be
//      baselines guessing off other baselines.
//   2. Re-score only the players who came back with a null xp, this time
//      passing pass 1's own "history" results as their cohort.
//
// `perSeason` is `[{ season, statsIndex, clubAppearances, cleanSheetRates },
// ...]`, most recent first. Any entry may have a null `statsIndex` (that
// season's stats fetch failed) and is then skipped for every player, exactly
// like historicalExpectedPoints already skips a gap season; an entirely empty
// `perSeason` (every season failed) degrades to xp: null / xpBasis: null for
// the whole pool rather than fabricating a number.
export function enrichPoolWithHistoricalXp(players, perSeason, requestCount = 0) {
  const list = players ?? [];
  const seasons = (perSeason ?? []).map((entry) => entry.season);

  if (!perSeason?.length || perSeason.every((entry) => !entry.statsIndex)) {
    return {
      players: list.map((player) => ({ ...player, xp: null, xpBasis: null })),
      header: { available: false, seasons, requestCount, basisCounts: { history: 0, estimate: 0, none: list.length } },
    };
  }

  const seasonLinesFor = (playerId) => perSeason.map((entry) => entry.statsIndex?.get(playerId) ?? null);
  const cleanSheetRatesFor = (playerId, lines) =>
    perSeason.map((entry, index) =>
      lines[index] ? weightedCleanSheetRate(entry.clubAppearances?.get(playerId), entry.cleanSheetRates) : 0,
    );

  const firstPass = list.map((player) => {
    const seasonLines = seasonLinesFor(player.id);
    const cleanSheetRates = cleanSheetRatesFor(player.id, seasonLines);
    const tier = player.tier ?? "unknown";
    const result = expectedPointsFor({ seasonLines, position: player.position, cleanSheetRates, tier });
    return { player, seasonLines, cleanSheetRates, tier, result };
  });

  const cohort = firstPass
    .filter((entry) => entry.result.basis === "history")
    .map((entry) => ({ position: entry.player.position, tier: entry.tier, xp: entry.result.xp }));

  const basisCounts = { history: 0, estimate: 0, none: 0 };
  const enriched = firstPass.map((entry) => {
    const final =
      entry.result.xp == null
        ? expectedPointsFor({
            seasonLines: entry.seasonLines,
            position: entry.player.position,
            cleanSheetRates: entry.cleanSheetRates,
            tier: entry.tier,
            cohort,
          })
        : entry.result;
    if (final.basis === "history") basisCounts.history += 1;
    else if (final.basis === "estimate") basisCounts.estimate += 1;
    else basisCounts.none += 1;
    return { ...entry.player, xp: final.xp, xpBasis: final.basis };
  });

  return { players: enriched, header: { available: true, seasons, requestCount, basisCounts } };
}
