import assert from "node:assert/strict";
import test from "node:test";

import {
  autoPick,
  isUniqueConstraintError,
  resolvePick,
  roundRobinSchedule,
  snakePickOrder,
  topQueuedPick,
  validatePick,
} from "../src/draftLogic.js";
import { SQUAD_SIZE, SQUAD_SLOTS } from "../src/fantasy.js";

test("isUniqueConstraintError recognises a D1 unique-violation message", () => {
  assert.equal(
    isUniqueConstraintError(new Error("D1_ERROR: UNIQUE constraint failed: fantasy_draft_picks.league_id, fantasy_draft_picks.overall_pick")),
    true,
  );
  assert.equal(isUniqueConstraintError({ message: "unique constraint failed" }), true);
});

test("isUniqueConstraintError rejects unrelated errors and missing input", () => {
  assert.equal(isUniqueConstraintError(new Error("network timeout")), false);
  assert.equal(isUniqueConstraintError(new Error()), false);
  assert.equal(isUniqueConstraintError(null), false);
  assert.equal(isUniqueConstraintError(undefined), false);
});

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

function player(id, position, xp) {
  const base = { id, position, name: `Player ${id}`, team: "Test FC" };
  return xp == null ? base : { ...base, xp };
}

// A pool shaped like the real one: several deep at every position, with xP
// descending within each. autoPick ranks by value over replacement, which is a
// property of the whole pool, so a two-or-three-player array cannot express what
// the ranking is meant to do (replacement level collapses onto the worst player
// present). `top` is the best xP at each position; forwards lead, keepers trail,
// exactly as they do in the shipped pool.
function deepPool({ GK = 3.0, DEF = 4.0, MID = 4.5, FWD = 5.0 } = {}, perPosition = 20) {
  const players = [];
  let id = 1;
  for (const [position, top] of Object.entries({ GK, DEF, MID, FWD })) {
    for (let i = 0; i < perPosition; i += 1) {
      players.push(player(id++, position, Number((top - i * 0.1).toFixed(2))));
    }
  }
  return players;
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

test("autoPick takes the best player on the board, not the scarcest bucket", () => {
  const available = deepPool();
  const pick = autoPick(available, [], SQUAD_SLOTS, 8);
  // The single best player in the pool, whatever position they play.
  assert.equal(pick.xp, 5.0);
  assert.equal(pick.position, "FWD");
});

// The regression this rule was rewritten for. GK has the fewest slots (2), so
// the old scarcest-bucket-first rule made every manager's opening pick a
// goalkeeper: an all-bot 8-manager draft took 16 straight keepers before a
// single outfielder, and the suggested-pick card advised humans to do the same.
test("autoPick never opens with a goalkeeper just because GK has the fewest slots", () => {
  const available = deepPool();
  for (const leagueSize of [2, 4, 8, 10]) {
    const pick = autoPick(available, [], SQUAD_SLOTS, leagueSize);
    assert.notEqual(pick.position, "GK", `opened with a keeper in a ${leagueSize}-manager league`);
  }
});

test("autoPick skips the best player when their bucket is already full", () => {
  const available = deepPool();
  // FWD is capped at 3; fill it, and the best forward must no longer be legal.
  const roster = [player(901, "FWD"), player(902, "FWD"), player(903, "FWD")];
  const pick = autoPick(available, roster, SQUAD_SLOTS, 8);
  assert.notEqual(pick.position, "FWD");
  assert.equal(pick.xp, 4.5); // the next-best legal player, a midfielder
});

// Slot arithmetic is what makes best-available safe: SQUAD_SLOTS sums to exactly
// SQUAD_SIZE, so unfilled slots always equal remaining picks and a thin bucket
// fills itself late by becoming the only legal one left.
test("autoPick still completes a legal 15-player squad without ever chasing scarcity", () => {
  const available = deepPool();
  const taken = new Set();
  const roster = [];
  for (let i = 0; i < SQUAD_SIZE; i += 1) {
    const pick = autoPick(
      available.filter((entry) => !taken.has(entry.id)),
      roster,
      SQUAD_SLOTS,
      8,
    );
    assert.ok(pick, `ran out of legal candidates at pick ${i + 1}`);
    taken.add(pick.id);
    roster.push(pick);
  }
  const counts = {};
  for (const entry of roster) counts[entry.position] = (counts[entry.position] ?? 0) + 1;
  assert.deepEqual(counts, SQUAD_SLOTS);
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

// -- topQueuedPick -------------------------------------------------------------
//
// Lives here (moved from src/fantasyDraft.js) so worker/draftRoom.js's alarm
// autopick can consult a manager's own shortlist without importing any
// browser-only module. Covered directly here (not just via fantasyDraft.js's
// re-export, which test/fantasy-draft.test.js already exercises) since this
// is now the function's real home and what the Durable Object actually calls.

test("topQueuedPick returns the first queued player who is both available and legal", () => {
  const pool = [
    { id: 1, name: "a", position: "MID" },
    { id: 2, name: "b", position: "FWD" },
  ];
  const pick = topQueuedPick([1, 2], pool, [], new Set());
  assert.equal(pick.id, 1);
});

test("topQueuedPick skips a queued player already drafted by someone else in the league", () => {
  const pool = [
    { id: 1, name: "a", position: "MID" },
    { id: 2, name: "b", position: "FWD" },
  ];
  const pick = topQueuedPick([1, 2], pool, [], new Set([1]));
  assert.equal(pick.id, 2);
});

test("topQueuedPick skips a queued player whose position bucket is already full on the roster", () => {
  const pool = [
    { id: 1, name: "a", position: "GK" },
    { id: 2, name: "b", position: "MID" },
  ];
  const fullGkRoster = [{ position: "GK" }, { position: "GK" }]; // SQUAD_SLOTS.GK is 2
  const pick = topQueuedPick([1, 2], pool, fullGkRoster, new Set());
  assert.equal(pick.id, 2);
});

test("topQueuedPick returns null once nothing in the queue is both available and legal - the caller's signal to fall back to autoPick", () => {
  const pool = [{ id: 1, name: "a", position: "GK" }];
  const fullGkRoster = [{ position: "GK" }, { position: "GK" }];
  assert.equal(topQueuedPick([1], pool, fullGkRoster, new Set()), null);
});

test("topQueuedPick returns null for an empty or unset queue rather than throwing", () => {
  const pool = [{ id: 1, name: "a", position: "MID" }];
  assert.equal(topQueuedPick([], pool, [], new Set()), null);
  assert.equal(topQueuedPick(undefined, pool, [], new Set()), null);
});

test("topQueuedPick accepts draftedIds as a Set, exactly what worker/draftRoom.js's this.draft.draftedPlayerIds is", () => {
  const pool = [{ id: 1, name: "a", position: "MID" }];
  const draftedIds = new Set();
  draftedIds.add(1);
  assert.equal(topQueuedPick([1], pool, [], draftedIds), null);
});
