import test from "node:test";
import assert from "node:assert/strict";

import { deriveTiersFromSeason, enrichPoolWithHistoricalXp } from "../src/fantasyHistoricalXp.js";

const line = (over = {}) => ({
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
  ...over,
});

// -- deriveTiersFromSeason (single most-recent season, unchanged semantics) -

test("deriveTiersFromSeason tags appearances/minutes/tier/likelyStarter from the most recent season", () => {
  const statsIndex = new Map([[1, line({ appearances: 38, minutes: 3420 })]]);
  const { players, header } = deriveTiersFromSeason(
    [{ id: 1, name: "A" }, { id: 2, name: "B" }],
    { season: "2025", statsIndex },
  );
  assert.equal(players[0].tier, "starter");
  assert.equal(players[0].likelyStarter, true);
  assert.equal(players[0].appearances, 38);
  // Player 2 has no record at all: "unknown", not a fabricated zero.
  assert.equal(players[1].tier, "unknown");
  assert.equal(players[1].appearances, null);
  assert.deepEqual(header, { available: true, season: "2025", playersWithoutRecord: 1 });
});

test("deriveTiersFromSeason returns players untouched when the most recent season has no stats", () => {
  const players = [{ id: 1, name: "A" }];
  const result = deriveTiersFromSeason(players, { season: "2025", statsIndex: null });
  assert.deepEqual(result.players, players);
  assert.equal(result.players[0].tier, undefined); // no enrichment at all, not a placeholder tier
  assert.deepEqual(result.header, { available: false, season: null, playersWithoutRecord: null });
});

test("deriveTiersFromSeason does not mutate its input array", () => {
  const players = [{ id: 1, name: "A" }];
  const statsIndex = new Map([[1, line({ appearances: 10, minutes: 900 })]]);
  deriveTiersFromSeason(players, { season: "2025", statsIndex });
  assert.equal(players[0].tier, undefined);
});

// -- enrichPoolWithHistoricalXp: the two-pass cohort discipline -------------

test("enrichPoolWithHistoricalXp scores a player with real history as basis history", () => {
  const statsIndex = new Map([[1, line({ appearances: 38, goals: 20 })]]);
  const perSeason = [{ season: "2025", statsIndex, clubAppearances: new Map(), cleanSheetRates: new Map() }];
  const { players, header } = enrichPoolWithHistoricalXp([{ id: 1, position: "FWD" }], perSeason, 29);
  assert.equal(players[0].xpBasis, "history");
  assert.ok(players[0].xp > 0);
  assert.deepEqual(header, { available: true, seasons: ["2025"], requestCount: 29, basisCounts: { history: 1, estimate: 0, none: 0 } });
});

test("enrichPoolWithHistoricalXp falls back to a same-position/tier cohort median for a no-history player", () => {
  const statsIndex = new Map([
    [1, line({ appearances: 38, goals: 10 })], // gives player 1 real history
    [2, line({ appearances: 38, goals: 12 })], // another starter MID, same cohort
  ]);
  const players = [
    { id: 1, position: "MID", tier: "starter" },
    { id: 2, position: "MID", tier: "starter" },
    { id: 3, position: "MID", tier: "starter" }, // no history at all, but a peer cohort exists
  ];
  const perSeason = [{ season: "2025", statsIndex, clubAppearances: new Map(), cleanSheetRates: new Map() }];
  const { players: enriched, header } = enrichPoolWithHistoricalXp(players, perSeason, 29);
  const noHistoryPlayer = enriched.find((p) => p.id === 3);
  assert.equal(noHistoryPlayer.xpBasis, "estimate");
  assert.ok(noHistoryPlayer.xp > 0);
  assert.equal(header.basisCounts.history, 2);
  assert.equal(header.basisCounts.estimate, 1);
});

test("enrichPoolWithHistoricalXp leaves xp/xpBasis null when there is neither history nor a cohort peer", () => {
  const perSeason = [{ season: "2025", statsIndex: new Map(), clubAppearances: new Map(), cleanSheetRates: new Map() }];
  const { players, header } = enrichPoolWithHistoricalXp([{ id: 1, position: "GK", tier: "unknown" }], perSeason, 5);
  assert.equal(players[0].xp, null);
  assert.equal(players[0].xpBasis, null);
  assert.equal(header.basisCounts.none, 1);
});

test("enrichPoolWithHistoricalXp degrades to xp: null for the whole pool when every season's stats fetch failed", () => {
  const perSeason = [
    { season: "2025", statsIndex: null, clubAppearances: null, cleanSheetRates: new Map() },
    { season: "2024", statsIndex: null, clubAppearances: null, cleanSheetRates: new Map() },
  ];
  const players = [{ id: 1, position: "FWD" }, { id: 2, position: "MID" }];
  const { players: enriched, header } = enrichPoolWithHistoricalXp(players, perSeason, 0);
  assert.ok(enriched.every((p) => p.xp === null && p.xpBasis === null));
  assert.equal(header.available, false);
  assert.deepEqual(header.seasons, ["2025", "2024"]);
  assert.equal(header.basisCounts.none, 2);
});

test("enrichPoolWithHistoricalXp skips a season a player has no record in, rather than treating it as zero", () => {
  // Player only has a record in the second (older) season - the gap season
  // must not dilute the real one (mirrors historicalExpectedPoints' own test).
  const seasonA = new Map(); // no record this season
  const seasonB = new Map([[1, line({ appearances: 38, goals: 15 })]]);
  const perSeasonWithGap = [
    { season: "2025", statsIndex: seasonA, clubAppearances: new Map(), cleanSheetRates: new Map() },
    { season: "2024", statsIndex: seasonB, clubAppearances: new Map(), cleanSheetRates: new Map() },
  ];
  const perSeasonSoloSeason = [{ season: "2024", statsIndex: seasonB, clubAppearances: new Map(), cleanSheetRates: new Map() }];

  const withGap = enrichPoolWithHistoricalXp([{ id: 1, position: "FWD" }], perSeasonWithGap, 0);
  const solo = enrichPoolWithHistoricalXp([{ id: 1, position: "FWD" }], perSeasonSoloSeason, 0);
  assert.equal(withGap.players[0].xp, solo.players[0].xp);
});

test("enrichPoolWithHistoricalXp weights a transferred player's clean-sheet rate across both clubs", () => {
  // A defender who played 30 games for a very leaky club (0 clean sheets) and
  // 8 for a very tight one (always clean) should score above a defender with
  // an identical goals/assists/cards line but zero clean-sheet credit at all.
  const statsIndex = new Map([
    [1, line({ appearances: 38, goals: 1, assists: 1 })],
    [2, line({ appearances: 38, goals: 1, assists: 1 })],
  ]);
  const clubAppearances = new Map([
    [1, new Map([["Leaky FC", 30], ["Tight FC", 8]])],
    // player 2 has no club breakdown at all - defaults to a 0 rate.
  ]);
  const cleanSheetRates = new Map([
    ["Leaky FC", 0],
    ["Tight FC", 1],
  ]);
  const perSeason = [{ season: "2025", statsIndex, clubAppearances, cleanSheetRates }];
  const { players } = enrichPoolWithHistoricalXp(
    [
      { id: 1, position: "DEF" },
      { id: 2, position: "DEF" },
    ],
    perSeason,
    0,
  );
  const withCleanSheets = players.find((p) => p.id === 1).xp;
  const withoutCleanSheets = players.find((p) => p.id === 2).xp;
  assert.ok(withCleanSheets > withoutCleanSheets, `expected ${withCleanSheets} > ${withoutCleanSheets}`);
});

test("enrichPoolWithHistoricalXp does not mutate its input players array", () => {
  const players = [{ id: 1, position: "FWD" }];
  const perSeason = [{ season: "2025", statsIndex: new Map(), clubAppearances: new Map(), cleanSheetRates: new Map() }];
  enrichPoolWithHistoricalXp(players, perSeason, 0);
  assert.equal(players[0].xp, undefined);
});
