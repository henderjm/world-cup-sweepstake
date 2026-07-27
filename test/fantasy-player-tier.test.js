import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPlayerClubAppearances,
  buildPriorSeasonStatsIndex,
  deriveTier,
  previousSeasonFor,
  previousSeasonsFor,
  sortPlayerPool,
  TIER_ORDER,
} from "../src/fantasyPlayerTier.js";

// A full normalizeSeasonLine-shaped line with everything but the given
// overrides at zero, for asserting buildPriorSeasonStatsIndex's output
// without restating every field in each test.
const fullLine = (over = {}) => ({
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

test("previousSeasonsFor: walks back count seasons, most recent first", () => {
  assert.deepEqual(previousSeasonsFor("2026", 3), ["2025", "2024", "2023"]);
  assert.deepEqual(previousSeasonsFor(2026), ["2025", "2024", "2023"]); // default count 3
  assert.deepEqual(previousSeasonsFor("2026", 1), ["2025"]);
});

test("previousSeasonsFor: rejects a non-numeric season, same as previousSeasonFor", () => {
  assert.throws(() => previousSeasonsFor("not-a-season", 3));
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

// buildPriorSeasonStatsIndex now returns the FULL normalizeSeasonLine shape
// (goals/assists/cards, not just appearances/minutes), so expectedPointsFor
// can score a season directly from it. deriveTier still only reads
// .appearances/.minutes off the same object, so it keeps working unchanged.

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
  assert.deepEqual(index.get(100), fullLine({ appearances: 22, minutes: 1870 }));
});

test("buildPriorSeasonStatsIndex: sums goals/assists/cards across rows too, not just appearances/minutes", () => {
  const pages = [
    {
      response: [
        {
          player: { id: 101 },
          statistics: [
            { league: { id: 39 }, games: { appearences: 20, minutes: 1800 }, goals: { total: 5, assists: 2 }, cards: { yellow: 3, yellowred: 1, red: 0 } },
            { league: { id: 39 }, games: { appearences: 10, minutes: 900 }, goals: { total: 2, assists: 1 }, cards: { yellow: 1, yellowred: 0, red: 1 } },
          ],
        },
      ],
    },
  ];
  const index = buildPriorSeasonStatsIndex(pages, 39);
  assert.deepEqual(
    index.get(101),
    fullLine({ appearances: 30, minutes: 2700, goals: 7, assists: 3, yellow: 4, yellowRed: 1, red: 1 }),
  );
});

test("buildPriorSeasonStatsIndex: merges duplicate rows for the same player across separate pages", () => {
  const pages = [
    { response: [{ player: { id: 200 }, statistics: [{ league: { id: 39 }, games: { appearences: 5, minutes: 400 } }] }] },
    { response: [{ player: { id: 200 }, statistics: [{ league: { id: 39 }, games: { appearences: 3, minutes: 200 } }] }] },
  ];
  const index = buildPriorSeasonStatsIndex(pages, 39);
  assert.deepEqual(index.get(200), fullLine({ appearances: 8, minutes: 600 }));
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
  assert.deepEqual(index.get(300), fullLine({ appearances: 4, minutes: 300 }));
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
  assert.deepEqual(index.get(500), fullLine({ appearances: 6, minutes: 500 }));
});

test("buildPriorSeasonStatsIndex: ignores malformed pages/entries without throwing", () => {
  const index = buildPriorSeasonStatsIndex([null, {}, { response: [null, { player: null }] }], 39);
  assert.equal(index.size, 0);
});

test("buildPriorSeasonStatsIndex: deriveTier still reads appearances/minutes off the fuller line unchanged", () => {
  const pages = [{ response: [{ player: { id: 600 }, statistics: [{ league: { id: 39 }, games: { appearences: 38, minutes: 3420 } }] }] }];
  const index = buildPriorSeasonStatsIndex(pages, 39);
  assert.equal(deriveTier(index.get(600)), "starter");
});

// -- buildPlayerClubAppearances: per-club breakdown for clean-sheet weighting -

test("buildPlayerClubAppearances: tracks appearances per club, normalized so a transfer's two spellings still match", () => {
  const pages = [
    {
      response: [
        {
          player: { id: 700 },
          statistics: [
            { league: { id: 39 }, team: { name: "Coventry" }, games: { appearences: 10 } },
            { league: { id: 39 }, team: { name: "Coventry City" }, games: { appearences: 5 } },
          ],
        },
      ],
    },
  ];
  const byClub = buildPlayerClubAppearances(pages, 39);
  // Both rows normalize to the same canonical club name and sum together.
  assert.deepEqual([...byClub.get(700).entries()], [["Coventry City", 15]]);
});

test("buildPlayerClubAppearances: keeps two genuinely different clubs separate", () => {
  const pages = [
    {
      response: [
        {
          player: { id: 701 },
          statistics: [
            { league: { id: 39 }, team: { name: "Arsenal" }, games: { appearences: 20 } },
            { league: { id: 39 }, team: { name: "Chelsea" }, games: { appearences: 10 } },
          ],
        },
      ],
    },
  ];
  const byClub = buildPlayerClubAppearances(pages, 39);
  assert.equal(byClub.get(701).get("Arsenal"), 20);
  assert.equal(byClub.get(701).get("Chelsea"), 10);
});

test("buildPlayerClubAppearances: ignores a different league and a zero-appearance row", () => {
  const pages = [
    {
      response: [
        {
          player: { id: 702 },
          statistics: [
            { league: { id: 2 }, team: { name: "Arsenal" }, games: { appearences: 40 } },
            { league: { id: 39 }, team: { name: "Arsenal" }, games: { appearences: 0 } },
          ],
        },
      ],
    },
  ];
  const byClub = buildPlayerClubAppearances(pages, 39);
  assert.equal(byClub.has(702), false);
});
