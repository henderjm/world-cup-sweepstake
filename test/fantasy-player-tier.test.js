import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPriorSeasonStatsIndex,
  deriveTier,
  previousSeasonFor,
  sortPlayerPool,
  TIER_ORDER,
} from "../src/fantasyPlayerTier.js";

test("deriveTier: no prior-season record is unknown, not fringe", () => {
  assert.equal(deriveTier(null), "unknown");
  assert.equal(deriveTier(undefined), "unknown");
});

test("deriveTier: a keeper with 0 appearances and 0 minutes is fringe", () => {
  assert.equal(deriveTier({ appearances: 0, minutes: 0 }), "fringe");
});

test("deriveTier: a keeper with 38 appearances is a starter", () => {
  assert.equal(deriveTier({ appearances: 38, minutes: 3420 }), "starter");
});

test("deriveTier: some minutes below the starter threshold is squad", () => {
  assert.equal(deriveTier({ appearances: 9, minutes: 450 }), "squad");
});

test("deriveTier: minutes exactly at the starter threshold count as starter", () => {
  assert.equal(deriveTier({ appearances: 10, minutes: 900 }), "starter");
});

test("deriveTier: one minute below the starter threshold is squad, not starter", () => {
  assert.equal(deriveTier({ appearances: 10, minutes: 899 }), "squad");
});

test("deriveTier: appearances alone (missing minutes) still signals squad", () => {
  assert.equal(deriveTier({ appearances: 3, minutes: undefined }), "squad");
});

test("deriveTier: tolerates non-numeric/missing fields without throwing", () => {
  assert.equal(deriveTier({}), "fringe");
  assert.equal(deriveTier({ appearances: null, minutes: null }), "fringe");
});

test("previousSeasonFor: derives the prior year from the configured season, not a hardcoded guess", () => {
  assert.equal(previousSeasonFor("2026"), "2025");
  assert.equal(previousSeasonFor(2026), "2025");
  assert.equal(previousSeasonFor("2020"), "2019");
});

test("previousSeasonFor: rejects a non-numeric season rather than silently miscomputing", () => {
  assert.throws(() => previousSeasonFor("not-a-season"));
});

test("sortPlayerPool: orders starter, squad, unknown, fringe", () => {
  const players = [
    { id: 1, tier: "fringe" },
    { id: 2, tier: "unknown" },
    { id: 3, tier: "starter" },
    { id: 4, tier: "squad" },
  ];
  const sorted = sortPlayerPool(players).map((p) => p.tier);
  assert.deepEqual(sorted, ["starter", "squad", "unknown", "fringe"]);
  assert.deepEqual(TIER_ORDER, ["starter", "squad", "unknown", "fringe"]);
});

test("sortPlayerPool: is a stable sort, preserving relative order within a tier", () => {
  const players = [
    { id: 1, tier: "squad", name: "a" },
    { id: 2, tier: "starter", name: "b" },
    { id: 3, tier: "squad", name: "c" },
    { id: 4, tier: "starter", name: "d" },
  ];
  const sorted = sortPlayerPool(players).map((p) => p.name);
  assert.deepEqual(sorted, ["b", "d", "a", "c"]);
});

test("sortPlayerPool: does not mutate the input array", () => {
  const players = [{ id: 1, tier: "fringe" }, { id: 2, tier: "starter" }];
  const copy = [...players];
  sortPlayerPool(players);
  assert.deepEqual(players, copy);
});

test("sortPlayerPool: is a no-op ordering when no player carries a tier (degraded/pre-enrichment shape)", () => {
  const players = [{ id: 3 }, { id: 1 }, { id: 2 }];
  const sorted = sortPlayerPool(players).map((p) => p.id);
  assert.deepEqual(sorted, [3, 1, 2]);
});

test("buildPriorSeasonStatsIndex: sums appearances/minutes across a mid-season transfer's two rows", () => {
  const pages = [
    {
      response: [
        {
          player: { id: 100 },
          statistics: [
            { league: { id: 39 }, games: { appearences: 10, minutes: 850 } },
            { league: { id: 39 }, games: { appearences: 12, minutes: 1020 } },
          ],
        },
      ],
    },
  ];
  const index = buildPriorSeasonStatsIndex(pages, 39);
  assert.deepEqual(index.get(100), { appearances: 22, minutes: 1870 });
});

test("buildPriorSeasonStatsIndex: merges duplicate rows for the same player across separate pages", () => {
  const pages = [
    { response: [{ player: { id: 200 }, statistics: [{ league: { id: 39 }, games: { appearences: 5, minutes: 400 } }] }] },
    { response: [{ player: { id: 200 }, statistics: [{ league: { id: 39 }, games: { appearences: 3, minutes: 200 } }] }] },
  ];
  const index = buildPriorSeasonStatsIndex(pages, 39);
  assert.deepEqual(index.get(200), { appearances: 8, minutes: 600 });
});

test("buildPriorSeasonStatsIndex: excludes statistics entries for a different league", () => {
  const pages = [
    {
      response: [
        {
          player: { id: 300 },
          statistics: [
            { league: { id: 39 }, games: { appearences: 4, minutes: 300 } },
            { league: { id: 2 }, games: { appearences: 40, minutes: 3600 } }, // Champions League, ignored
          ],
        },
      ],
    },
  ];
  const index = buildPriorSeasonStatsIndex(pages, 39);
  assert.deepEqual(index.get(300), { appearances: 4, minutes: 300 });
});

test("buildPriorSeasonStatsIndex: a player with no league-39 statistics is absent from the index (unknown)", () => {
  const pages = [
    { response: [{ player: { id: 400 }, statistics: [{ league: { id: 2 }, games: { appearences: 1, minutes: 90 } }] }] },
  ];
  const index = buildPriorSeasonStatsIndex(pages, 39);
  assert.equal(index.has(400), false);
});

test("buildPriorSeasonStatsIndex: accepts the correctly-spelled 'appearances' field too", () => {
  const pages = [
    { response: [{ player: { id: 500 }, statistics: [{ league: { id: 39 }, games: { appearances: 6, minutes: 500 } }] }] },
  ];
  const index = buildPriorSeasonStatsIndex(pages, 39);
  assert.deepEqual(index.get(500), { appearances: 6, minutes: 500 });
});

test("buildPriorSeasonStatsIndex: ignores malformed pages/entries without throwing", () => {
  const index = buildPriorSeasonStatsIndex([null, {}, { response: [null, { player: null }] }], 39);
  assert.equal(index.size, 0);
});
