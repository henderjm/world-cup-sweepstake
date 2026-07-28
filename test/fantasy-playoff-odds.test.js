import test from "node:test";
import assert from "node:assert/strict";

import { roundRobinSchedule } from "../src/draftLogic.js";
import { STARTING_SIZE } from "../src/fantasy.js";
import { standingsFromFixtures } from "../src/fantasyGameweek.js";
import {
  DEFAULT_ITERATIONS,
  DEFAULT_PLAYOFF_SPOTS,
  MIN_REALISED_SAMPLES_FOR_SPREAD,
  SQUAD_SPREAD_COEFFICIENT_OF_VARIATION,
  clinchStatus,
  managerWeeklyMeans,
  mergeStandings,
  pointsBoundsByUser,
  projectedWeeklySpread,
  remainingGamesByUser,
  simulatePlayoffOdds,
} from "../src/fantasyPlayoffOdds.js";

const SIX = [1, 2, 3, 4, 5, 6].map((id) => ({ userId: id, name: `M${id}` }));

function symmetricManagers(members, meanWeeklyPoints = 50) {
  return members.map((member) => ({ userId: member.userId, meanWeeklyPoints }));
}

// -- projectedWeeklySpread ----------------------------------------------------

test("projectedWeeklySpread uses the sample stddev once there are enough realised weeks", () => {
  const spread = projectedWeeklySpread({ meanWeeklyPoints: 50, weeklyScores: [40, 50, 60, 50] });
  // sample variance (n-1) of [40,50,60,50]: mean 50, deviations -10,0,10,0 -> sum sq 200 / 3
  const expected = Math.sqrt(200 / 3);
  assert.ok(Math.abs(spread - expected) < 1e-9);
});

test("projectedWeeklySpread falls back to the squad-derived estimate below the sample threshold", () => {
  assert.equal(MIN_REALISED_SAMPLES_FOR_SPREAD, 3);
  const spread = projectedWeeklySpread({ meanWeeklyPoints: 50, weeklyScores: [40, 60] }); // only 2 samples
  assert.ok(Math.abs(spread - 50 * SQUAD_SPREAD_COEFFICIENT_OF_VARIATION) < 1e-9);
});

test("projectedWeeklySpread never goes negative for a missing/negative mean", () => {
  assert.equal(projectedWeeklySpread({ meanWeeklyPoints: undefined, weeklyScores: [] }), 0);
  assert.equal(projectedWeeklySpread({ meanWeeklyPoints: -20, weeklyScores: [] }), 0);
});

test("SQUAD_SPREAD_COEFFICIENT_OF_VARIATION is the demo's starter-tier CV shrunk by sqrt(STARTING_SIZE)", () => {
  const perPlayerCv = 3.2 / 5.6; // DEMO_TIER_STDDEV.starter / DEMO_TIER_MEAN.starter
  assert.ok(Math.abs(SQUAD_SPREAD_COEFFICIENT_OF_VARIATION - perPlayerCv / Math.sqrt(STARTING_SIZE)) < 1e-12);
});

// -- remainingGamesByUser / pointsBoundsByUser / clinchStatus ------------------

test("remainingGamesByUser counts both sides of every undecided fixture", () => {
  const remaining = [
    { gameweek: 5, homeUserId: "A", awayUserId: "B" },
    { gameweek: 5, homeUserId: "C", awayUserId: "A" },
  ];
  const counts = remainingGamesByUser(remaining);
  assert.equal(counts.get("A"), 2);
  assert.equal(counts.get("B"), 1);
  assert.equal(counts.get("C"), 1);
});

test("remainingGamesByUser defaults an untouched manager to a lookup miss, not a thrown error", () => {
  const counts = remainingGamesByUser([]);
  assert.equal(counts.get("nobody"), undefined);
});

test("clinchStatus eliminates a manager once enough others have already banked more than their ceiling", () => {
  const members = [
    { userId: "A", name: "A" },
    { userId: "B", name: "B" },
    { userId: "C", name: "C" },
    { userId: "D", name: "D" },
  ];
  // A and B already have 30 points each and nothing left to play; C and D are
  // both on 0 with one game left each (max reachable: 3). With 2 playoff
  // spots, both C and D are mathematically out: two managers (A, B) already
  // sit above what either could ever reach.
  const decided = [];
  for (let gw = 1; gw <= 10; gw++) decided.push({ gameweek: gw, homeUserId: "A", awayUserId: "D", homeScore: 80, awayScore: 10 });
  for (let gw = 1; gw <= 10; gw++) decided.push({ gameweek: gw, homeUserId: "B", awayUserId: "C", homeScore: 70, awayScore: 20 });
  const remaining = [{ gameweek: 11, homeUserId: "D", awayUserId: "C" }];

  const standings = simulatePlayoffOdds({
    members,
    fixtures: [...decided, ...remaining],
    managers: symmetricManagers(members),
    playoffSpots: 2,
    iterations: 500,
    seed: "elimination",
  }).standings;

  const byId = new Map(standings.map((row) => [row.userId, row]));
  assert.equal(byId.get("A").status, "clinched");
  assert.equal(byId.get("A").probability, 1);
  assert.equal(byId.get("B").status, "clinched");
  assert.equal(byId.get("B").probability, 1);
  assert.equal(byId.get("C").status, "eliminated");
  assert.equal(byId.get("C").probability, 0); // a computed fact, not a small positive number
  assert.equal(byId.get("D").status, "eliminated");
  assert.equal(byId.get("D").probability, 0);
});

test("pointsBoundsByUser and clinchStatus agree when called directly (unit-level, no simulation)", () => {
  const standings = [
    { userId: "A", recordPoints: 30, pointsFor: 500 },
    { userId: "B", recordPoints: 0, pointsFor: 100 },
  ];
  // A has 0 games left (floor == ceiling == 30); B has 1 game left (ceiling 3).
  const remainingByUser = new Map([["B", 1]]);
  const bounds = pointsBoundsByUser({ standings, remainingByUser });
  assert.deepEqual(bounds.get("A"), { floor: 30, ceiling: 30, pointsFor: 500, remainingGames: 0 });
  assert.deepEqual(bounds.get("B"), { floor: 0, ceiling: 3, pointsFor: 100, remainingGames: 1 });

  const statuses = clinchStatus({ bounds, playoffSpots: 1 });
  assert.equal(statuses.get("A"), "clinched"); // B's ceiling (3) can never reach A's floor (30)
  assert.equal(statuses.get("B"), "eliminated"); // A's floor (30) already exceeds B's ceiling (3)
});

// -- simulatePlayoffOdds: properties over a full season ------------------------

test("odds across a league sum to the number of playoff places, within sampling tolerance", () => {
  const fixtures = roundRobinSchedule(SIX.map((m) => m.userId), 38);
  const result = simulatePlayoffOdds({
    members: SIX,
    fixtures,
    managers: symmetricManagers(SIX),
    playoffSpots: 4,
    iterations: DEFAULT_ITERATIONS,
    seed: "sum-check",
  });
  const sum = result.standings.reduce((total, row) => total + row.probability, 0);
  assert.ok(Math.abs(sum - 4) < 0.02, `expected sum near 4, got ${sum}`);
});

test("before any fixture is decided, a symmetric league's odds are near-identical", () => {
  const fixtures = roundRobinSchedule(SIX.map((m) => m.userId), 38);
  const result = simulatePlayoffOdds({
    members: SIX,
    fixtures,
    managers: symmetricManagers(SIX, 50),
    playoffSpots: 4,
    iterations: DEFAULT_ITERATIONS,
    seed: "symmetric",
  });
  const probabilities = result.standings.map((row) => row.probability);
  const expected = 4 / 6;
  for (const p of probabilities) {
    assert.ok(Math.abs(p - expected) < 0.03, `expected close to ${expected}, got ${p}`);
  }
});

test("a dominant manager's odds exceed a struggling manager's", () => {
  const fixtures = roundRobinSchedule(SIX.map((m) => m.userId), 38);
  const managers = [
    { userId: 1, meanWeeklyPoints: 70 }, // dominant
    { userId: 2, meanWeeklyPoints: 50 },
    { userId: 3, meanWeeklyPoints: 50 },
    { userId: 4, meanWeeklyPoints: 50 },
    { userId: 5, meanWeeklyPoints: 50 },
    { userId: 6, meanWeeklyPoints: 20 }, // struggling
  ];
  const result = simulatePlayoffOdds({
    members: SIX,
    fixtures,
    managers,
    playoffSpots: 4,
    iterations: DEFAULT_ITERATIONS,
    seed: "dominant-vs-struggling",
  });
  const byId = new Map(result.standings.map((row) => [row.userId, row]));
  assert.ok(byId.get(1).probability > byId.get(6).probability);
});

test("determinism: identical input gives byte-identical output", () => {
  const fixtures = roundRobinSchedule(SIX.map((m) => m.userId), 38);
  const args = {
    members: SIX,
    fixtures,
    managers: [
      { userId: 1, meanWeeklyPoints: 65, weeklyScores: [60, 70, 55] },
      { userId: 2, meanWeeklyPoints: 55 },
      { userId: 3, meanWeeklyPoints: 50 },
      { userId: 4, meanWeeklyPoints: 45 },
      { userId: 5, meanWeeklyPoints: 40 },
      { userId: 6, meanWeeklyPoints: 35 },
    ],
    playoffSpots: 3,
    iterations: 2000,
    seed: "determinism-check",
  };
  const first = simulatePlayoffOdds(args);
  const second = simulatePlayoffOdds(args);
  assert.deepEqual(first, second);
});

test("a mathematically eliminated manager reports eliminated with probability 0, not a small positive number", () => {
  const members = [
    { userId: "A", name: "A" },
    { userId: "B", name: "B" },
    { userId: "C", name: "C" },
    { userId: "D", name: "D" },
  ];
  const decided = [];
  for (let gw = 1; gw <= 10; gw++) decided.push({ gameweek: gw, homeUserId: "A", awayUserId: "D", homeScore: 80, awayScore: 10 });
  for (let gw = 1; gw <= 10; gw++) decided.push({ gameweek: gw, homeUserId: "B", awayUserId: "C", homeScore: 70, awayScore: 20 });
  const remaining = [{ gameweek: 11, homeUserId: "D", awayUserId: "C" }];
  const result = simulatePlayoffOdds({
    members,
    fixtures: [...decided, ...remaining],
    managers: symmetricManagers(members),
    playoffSpots: 2,
    iterations: DEFAULT_ITERATIONS,
    seed: "eliminated-report",
  });
  const d = result.standings.find((row) => row.userId === "D");
  assert.equal(d.status, "eliminated");
  assert.equal(d.probability, 0);
});

// -- Convergence: the claim behind DEFAULT_ITERATIONS --------------------------

test("convergence: doubling iterations from 2500 to 5000 moves every manager's odds by less than 1 point", () => {
  const fixtures = roundRobinSchedule(SIX.map((m) => m.userId), 38);
  const managers = [
    { userId: 1, meanWeeklyPoints: 60 },
    { userId: 2, meanWeeklyPoints: 55 },
    { userId: 3, meanWeeklyPoints: 50 },
    { userId: 4, meanWeeklyPoints: 46 },
    { userId: 5, meanWeeklyPoints: 44 },
    { userId: 6, meanWeeklyPoints: 40 },
  ];
  const seed = "convergence-check";
  const half = simulatePlayoffOdds({ members: SIX, fixtures, managers, playoffSpots: 4, iterations: 2500, seed });
  const full = simulatePlayoffOdds({ members: SIX, fixtures, managers, playoffSpots: 4, iterations: 5000, seed });

  const halfById = new Map(half.standings.map((row) => [row.userId, row.probability]));
  const fullById = new Map(full.standings.map((row) => [row.userId, row.probability]));
  let maxDelta = 0;
  for (const [userId, p] of halfById) {
    maxDelta = Math.max(maxDelta, Math.abs(p - fullById.get(userId)));
  }
  assert.ok(maxDelta < 0.01, `expected convergence within 1 point, max delta was ${maxDelta}`);
});

// -- League too small for a playoff -------------------------------------------

test("a league no bigger than its own playoff cutoff reports everyone clinched without simulating", () => {
  const members = [1, 2, 3].map((id) => ({ userId: id, name: `M${id}` }));
  const result = simulatePlayoffOdds({ members, fixtures: [], playoffSpots: 4 });
  assert.equal(result.tooSmallForPlayoffs, true);
  assert.equal(result.iterations, 0);
  assert.equal(result.standings.length, 3);
  for (const row of result.standings) {
    assert.equal(row.status, "clinched");
    assert.equal(row.probability, 1);
  }
});

test("an empty league returns an empty, tooSmallForPlayoffs result rather than throwing", () => {
  const result = simulatePlayoffOdds({ members: [], fixtures: [] });
  assert.equal(result.tooSmallForPlayoffs, true);
  assert.deepEqual(result.standings, []);
});

test("DEFAULT_PLAYOFF_SPOTS is a documented default, not silently hardcoded past this constant", () => {
  assert.equal(DEFAULT_PLAYOFF_SPOTS, 4);
  const fixtures = roundRobinSchedule(SIX.map((m) => m.userId), 38);
  const explicit = simulatePlayoffOdds({
    members: SIX,
    fixtures,
    managers: symmetricManagers(SIX),
    iterations: 200,
    seed: "default-check",
  });
  assert.equal(explicit.playoffSpots, DEFAULT_PLAYOFF_SPOTS);
});

// -- A season already fully decided --------------------------------------------

test("a fully decided season needs no sampling: standings alone resolve everyone's status", () => {
  const members = [
    { userId: "A", name: "A" },
    { userId: "B", name: "B" },
    { userId: "C", name: "C" },
  ];
  const fixtures = [
    { gameweek: 1, homeUserId: "A", awayUserId: "B", homeScore: 60, awayScore: 40 },
    { gameweek: 1, homeUserId: "B", awayUserId: "C", homeScore: 50, awayScore: 30 },
    { gameweek: 2, homeUserId: "A", awayUserId: "C", homeScore: 55, awayScore: 45 },
  ];
  const result = simulatePlayoffOdds({
    members,
    fixtures,
    managers: symmetricManagers(members),
    playoffSpots: 1,
    iterations: 500,
    seed: "decided-season",
  });
  const byId = new Map(result.standings.map((row) => [row.userId, row]));
  assert.equal(byId.get("A").status, "clinched");
  assert.equal(byId.get("A").probability, 1);
  assert.equal(byId.get("B").status, "eliminated");
  assert.equal(byId.get("C").status, "eliminated");
});

// -- mergeStandings ------------------------------------------------------------

test("mergeStandings is standingsFromFixtures over the union of two disjoint halves", () => {
  const members = [
    { userId: "A", name: "A" },
    { userId: "B", name: "B" },
    { userId: "C", name: "C" },
  ];
  const first = [
    { gameweek: 1, homeUserId: "A", awayUserId: "B", homeScore: 60, awayScore: 40 },
    { gameweek: 2, homeUserId: "B", awayUserId: "C", homeScore: 50, awayScore: 50 },
  ];
  const second = [
    { gameweek: 3, homeUserId: "A", awayUserId: "C", homeScore: 30, awayScore: 70 },
    { gameweek: 4, homeUserId: "C", awayUserId: "B", homeScore: 20, awayScore: 44 },
  ];

  const merged = mergeStandings(standingsFromFixtures(first, members), standingsFromFixtures(second, members));
  const direct = standingsFromFixtures([...first, ...second], members);
  assert.deepEqual(merged, direct);
});

test("mergeStandings keeps a member the base table never listed", () => {
  const merged = mergeStandings(
    [{ userId: "A", name: "A", played: 2, wins: 2, draws: 0, losses: 0, pointsFor: 100, pointsAgainst: 60 }],
    [{ userId: "B", name: "B", played: 0, wins: 0, draws: 0, losses: 0, pointsFor: 0, pointsAgainst: 0 }],
  );
  assert.deepEqual(merged.map((row) => row.userId), ["A", "B"]);
  assert.equal(merged[0].recordPoints, 6);
  assert.equal(merged[1].recordPoints, 0);
});

// -- decidedStandings: the browser's "table without the fixture log" path -------

test("decidedStandings + remaining fixtures gives the same odds as the full fixture log", () => {
  const members = [1, 2, 3, 4, 5, 6].map((id) => ({ userId: id, name: `M${id}` }));
  const all = roundRobinSchedule(members.map((m) => m.userId), 38);
  // Settle everything up to gameweek 10 with a lopsided but deterministic
  // result, so the two paths are compared on a season that actually has a
  // banked record rather than an empty one.
  const withResults = all.map((fixture) =>
    fixture.gameweek <= 10
      ? { ...fixture, homeScore: 40 + fixture.homeUserId, awayScore: 40 + fixture.awayUserId }
      : fixture,
  );
  const managers = symmetricManagers(members, 50);

  const fromFixtures = simulatePlayoffOdds({
    members,
    fixtures: withResults,
    managers,
    playoffSpots: 4,
    iterations: 400,
    seed: "parity",
  });
  const decided = withResults.filter((fixture) => fixture.gameweek <= 10);
  const remaining = withResults.filter((fixture) => fixture.gameweek > 10);
  const fromTable = simulatePlayoffOdds({
    members,
    fixtures: remaining,
    decidedStandings: standingsFromFixtures(decided, members),
    managers,
    playoffSpots: 4,
    iterations: 400,
    seed: "parity",
  });

  assert.deepEqual(fromTable.standings, fromFixtures.standings);
});

// -- managerWeeklyMeans --------------------------------------------------------

function squad(prefix, xps) {
  // 2 GK / 5 DEF / 5 MID / 3 FWD, matching SQUAD_SLOTS, so defaultLineup can
  // always build a legal XI out of it.
  const shape = ["GK", "GK", "DEF", "DEF", "DEF", "DEF", "DEF", "MID", "MID", "MID", "MID", "MID", "FWD", "FWD", "FWD"];
  return shape.map((position, index) => ({
    id: `${prefix}${index}`,
    position,
    xp: xps?.[index] ?? 4,
  }));
}

test("managerWeeklyMeans doubles the highest-xP starter, never the fill order's first keeper", () => {
  const members = [{ userId: "A", name: "A" }];
  // One standout forward: he must be the captain, not the goalkeeper that
  // defaultLineup's GK-first fill order happens to place first.
  const roster = squad("a");
  roster[12] = { id: "a12", position: "FWD", xp: 12 };
  const [projection] = managerWeeklyMeans(members, new Map([["A", roster]]));

  const flat = managerWeeklyMeans(members, new Map([["A", squad("b")]]))[0];
  // The XI is 11 players at 4 with one at 12 replacing a 4, and the captain
  // doubling lands on the 12.
  assert.equal(flat.meanWeeklyPoints, 4 * 11 + 4);
  assert.equal(projection.meanWeeklyPoints, 4 * 10 + 12 + 12);
});

test("managerWeeklyMeans projects an empty or unknown roster to zero rather than throwing", () => {
  const means = managerWeeklyMeans([{ userId: "A" }, { userId: "B" }], new Map([["A", []]]));
  assert.deepEqual(means, [
    { userId: "A", meanWeeklyPoints: 0 },
    { userId: "B", meanWeeklyPoints: 0 },
  ]);
});
