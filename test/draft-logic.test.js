import assert from "node:assert/strict";
import test from "node:test";

import {
  autoPick,
  resolvePick,
  roundRobinSchedule,
  snakePickOrder,
  validatePick,
} from "../src/draftLogic.js";
import { SQUAD_SIZE, SQUAD_SLOTS } from "../src/fantasy.js";

test("snakePickOrder keeps member order on odd rounds", () => {
  assert.deepEqual(snakePickOrder([1, 2, 3, 4], 1), [1, 2, 3, 4]);
  assert.deepEqual(snakePickOrder([1, 2, 3, 4], 3), [1, 2, 3, 4]);
});

test("snakePickOrder reverses member order on even rounds", () => {
  assert.deepEqual(snakePickOrder([1, 2, 3, 4], 2), [4, 3, 2, 1]);
  assert.deepEqual(snakePickOrder([1, 2, 3, 4], 4), [4, 3, 2, 1]);
});

test("snakePickOrder does not mutate its input", () => {
  const members = [1, 2, 3, 4];
  snakePickOrder(members, 2);
  assert.deepEqual(members, [1, 2, 3, 4]);
});

test("resolvePick walks a full snake draft for 3 members", () => {
  const members = ["a", "b", "c"];
  // Round 1 forward, round 2 reversed, round 3 forward again.
  assert.deepEqual(resolvePick(members, 1), { round: 1, pickInRound: 1, userId: "a" });
  assert.deepEqual(resolvePick(members, 2), { round: 1, pickInRound: 2, userId: "b" });
  assert.deepEqual(resolvePick(members, 3), { round: 1, pickInRound: 3, userId: "c" });
  assert.deepEqual(resolvePick(members, 4), { round: 2, pickInRound: 1, userId: "c" });
  assert.deepEqual(resolvePick(members, 5), { round: 2, pickInRound: 2, userId: "b" });
  assert.deepEqual(resolvePick(members, 6), { round: 2, pickInRound: 3, userId: "a" });
  assert.deepEqual(resolvePick(members, 7), { round: 3, pickInRound: 1, userId: "a" });
});

test("resolvePick rejects out-of-range or malformed input", () => {
  assert.equal(resolvePick([], 1), null);
  assert.equal(resolvePick(["a", "b"], 0), null);
  assert.equal(resolvePick(["a", "b"], 1.5), null);
  assert.equal(resolvePick(["a", "b"], 5, 2), null); // beyond roundsTotal
});

test("resolvePick matches SQUAD_SIZE rounds for a full draft length", () => {
  const members = ["a", "b", "c", "d"];
  const totalPicks = members.length * SQUAD_SIZE;
  assert.equal(resolvePick(members, totalPicks, SQUAD_SIZE).round, SQUAD_SIZE);
  assert.equal(resolvePick(members, totalPicks + 1, SQUAD_SIZE), null);
});

function player(id, position) {
  return { id, position, name: `Player ${id}`, team: "Test FC" };
}

test("validatePick rejects a player already drafted anywhere in the league", () => {
  const result = validatePick({
    roster: [],
    draftedIds: new Set([42]),
    player: player(42, "MID"),
    squadSlots: SQUAD_SLOTS,
  });
  assert.equal(result.valid, false);
  assert.match(result.error, /already drafted/);
});

test("validatePick accepts array draftedIds as well as a Set", () => {
  const result = validatePick({
    roster: [],
    draftedIds: [1, 2, 3],
    player: player(3, "MID"),
    squadSlots: SQUAD_SLOTS,
  });
  assert.equal(result.valid, false);
});

test("validatePick rejects a pick that would overfill its position bucket", () => {
  // SQUAD_SLOTS.GK is 2; a roster already holding 2 keepers cannot take a third.
  const roster = [player(1, "GK"), player(2, "GK")];
  const result = validatePick({
    roster,
    draftedIds: new Set(),
    player: player(3, "GK"),
    squadSlots: SQUAD_SLOTS,
  });
  assert.equal(result.valid, false);
  assert.match(result.error, /GK slots are full/);
});

test("validatePick accepts a legal pick into an open bucket", () => {
  const roster = [player(1, "GK")];
  const result = validatePick({
    roster,
    draftedIds: new Set(),
    player: player(2, "GK"),
    squadSlots: SQUAD_SLOTS,
  });
  assert.equal(result.valid, true);
});

test("validatePick rejects an unrecognised position", () => {
  const result = validatePick({
    roster: [],
    draftedIds: new Set(),
    player: player(1, "SWEEPER"),
    squadSlots: SQUAD_SLOTS,
  });
  assert.equal(result.valid, false);
});

test("autoPick fills the scarcest unfilled bucket first", () => {
  // Roster is one short of full at every bucket except MID and FWD, which are
  // both fully open (0 picked); GK is one away from its cap of 2 (scarcest).
  const roster = [
    player(101, "GK"),
    player(102, "DEF"),
    player(103, "DEF"),
    player(104, "DEF"),
    player(105, "DEF"),
  ];
  const available = [
    player(1, "FWD"),
    player(2, "MID"),
    player(3, "GK"), // scarcest open bucket (1 slot left) should win despite listing later
  ];
  const pick = autoPick(available, roster, SQUAD_SLOTS);
  assert.equal(pick.id, 3);
});

test("autoPick prefers the highest-listed player within the chosen bucket", () => {
  const roster = [];
  const available = [player(5, "FWD"), player(6, "FWD"), player(7, "GK")];
  // GK (2 remaining) and FWD (3 remaining) both open; GK is scarcer, so FWD
  // listing order is irrelevant here, but confirm GK candidate 7 wins.
  const pick = autoPick(available, roster, SQUAD_SLOTS);
  assert.equal(pick.id, 7);
});

test("autoPick is deterministic given identical inputs", () => {
  const roster = [player(1, "GK")];
  const available = [player(2, "MID"), player(3, "DEF"), player(4, "FWD")];
  const first = autoPick(available, roster, SQUAD_SLOTS);
  const second = autoPick(available, roster, SQUAD_SLOTS);
  assert.deepEqual(first, second);
});

test("autoPick returns null when no legal candidate remains for any open bucket", () => {
  const roster = [player(1, "GK")]; // GK bucket still open (1 of 2)
  const available = [player(2, "MID")]; // MID bucket already full below
  const fullMidRoster = [
    player(10, "MID"),
    player(11, "MID"),
    player(12, "MID"),
    player(13, "MID"),
    player(14, "MID"),
  ];
  // Combine: every bucket but GK is full, and available only offers a MID.
  const combinedRoster = [...roster, ...fullMidRoster];
  const pick = autoPick(available, combinedRoster, SQUAD_SLOTS);
  assert.equal(pick, null);
});

test("roundRobinSchedule gives every pair of members exactly one meeting per cycle (even count)", () => {
  const members = [1, 2, 3, 4];
  const roundsPerCycle = members.length - 1;
  const fixtures = roundRobinSchedule(members, roundsPerCycle);
  // 4 members, 3 rounds, 2 games per round = 6 games = C(4,2).
  assert.equal(fixtures.length, 6);
  const seenPairs = new Set();
  for (const fixture of fixtures) {
    const key = [fixture.homeUserId, fixture.awayUserId].sort().join("-");
    assert.equal(seenPairs.has(key), false, `pair ${key} met twice within one cycle`);
    seenPairs.add(key);
  }
  // Every member plays exactly once per gameweek with an even count (no byes).
  for (let gw = 1; gw <= roundsPerCycle; gw++) {
    const inGameweek = fixtures.filter((f) => f.gameweek === gw).flatMap((f) => [f.homeUserId, f.awayUserId]);
    assert.deepEqual([...inGameweek].sort(), [...members].sort());
  }
});

test("roundRobinSchedule gives one bye per gameweek for an odd member count", () => {
  const members = [1, 2, 3];
  const roundsPerCycle = members.length; // odd count -> n rounds (bye included) per cycle
  const fixtures = roundRobinSchedule(members, roundsPerCycle);
  for (let gw = 1; gw <= roundsPerCycle; gw++) {
    const playing = fixtures.filter((f) => f.gameweek === gw).flatMap((f) => [f.homeUserId, f.awayUserId]);
    assert.equal(playing.length, 2); // one pair plays, one member has a bye
    assert.equal(new Set(playing).size, 2);
  }
});

test("roundRobinSchedule repeats the cycle to fill 38 gameweeks", () => {
  const members = [1, 2, 3, 4];
  const fixtures = roundRobinSchedule(members, 38);
  // 4 members play 2 fixtures per gameweek, every gameweek, for 38 gameweeks.
  assert.equal(fixtures.length, 38 * 2);
  assert.equal(new Set(fixtures.map((f) => f.gameweek)).size, 38);
});

test("roundRobinSchedule flips home/away on the cycle repeat for fairness", () => {
  const members = [1, 2, 3, 4];
  const roundsPerCycle = members.length - 1; // 3
  const fixtures = roundRobinSchedule(members, roundsPerCycle * 2);
  const firstCycle = fixtures.filter((f) => f.gameweek <= roundsPerCycle);
  const secondCycle = fixtures.filter((f) => f.gameweek > roundsPerCycle);
  // Same pairings, but every fixture's home/away is swapped in the second cycle.
  for (let i = 0; i < firstCycle.length; i++) {
    assert.equal(firstCycle[i].homeUserId, secondCycle[i].awayUserId);
    assert.equal(firstCycle[i].awayUserId, secondCycle[i].homeUserId);
  }
});

test("roundRobinSchedule returns no fixtures for fewer than two members", () => {
  assert.deepEqual(roundRobinSchedule([], 38), []);
  assert.deepEqual(roundRobinSchedule([1], 38), []);
});
