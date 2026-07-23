import assert from "node:assert/strict";
import test from "node:test";

import { canDraftPlayer, draftOrderEntries, formatCountdown, reduceDraftMessage, squadBucketCounts } from "../src/fantasyDraft.js";

test("formatCountdown renders mm:ss and rounds up to the next full second", () => {
  assert.equal(formatCountdown(60000), "1:00");
  assert.equal(formatCountdown(45000), "0:45");
  assert.equal(formatCountdown(500), "0:01");
  assert.equal(formatCountdown(0), "0:00");
});

test("formatCountdown clamps negative or missing input to zero", () => {
  assert.equal(formatCountdown(-500), "0:00");
  assert.equal(formatCountdown(undefined), "0:00");
});

test("formatCountdown pads single-digit seconds", () => {
  assert.equal(formatCountdown(65000), "1:05");
});

test("squadBucketCounts starts every bucket at zero for an empty roster", () => {
  const counts = squadBucketCounts([]);
  assert.deepEqual(counts, {
    GK: { filled: 0, total: 2 },
    DEF: { filled: 0, total: 5 },
    MID: { filled: 0, total: 5 },
    FWD: { filled: 0, total: 3 },
  });
});

test("squadBucketCounts tallies drafted players by position", () => {
  const roster = [
    { id: 1, position: "GK" },
    { id: 2, position: "DEF" },
    { id: 3, position: "DEF" },
  ];
  const counts = squadBucketCounts(roster);
  assert.equal(counts.GK.filled, 1);
  assert.equal(counts.DEF.filled, 2);
  assert.equal(counts.MID.filled, 0);
  assert.equal(counts.FWD.filled, 0);
});

function player(id, position) {
  return { id, position, name: `Player ${id}`, team: "Test FC" };
}

test("canDraftPlayer is false when it is not my turn", () => {
  const result = canDraftPlayer(player(1, "GK"), { isMyTurn: false, myRoster: [], draftedIds: new Set() });
  assert.equal(result, false);
});

test("canDraftPlayer is false for a player already drafted anywhere in the league", () => {
  const result = canDraftPlayer(player(1, "GK"), {
    isMyTurn: true,
    myRoster: [],
    draftedIds: new Set([1]),
  });
  assert.equal(result, false);
});

test("canDraftPlayer is false once my bucket for that position is full", () => {
  const myRoster = [player(10, "GK"), player(11, "GK")]; // GK cap is 2
  const result = canDraftPlayer(player(1, "GK"), { isMyTurn: true, myRoster, draftedIds: new Set() });
  assert.equal(result, false);
});

test("canDraftPlayer is true for a legal pick on my turn", () => {
  const result = canDraftPlayer(player(1, "MID"), { isMyTurn: true, myRoster: [], draftedIds: new Set() });
  assert.equal(result, true);
});

test("canDraftPlayer is false for a missing or id-less player", () => {
  assert.equal(canDraftPlayer(null, { isMyTurn: true, myRoster: [], draftedIds: new Set() }), false);
  assert.equal(canDraftPlayer({ position: "GK" }, { isMyTurn: true, myRoster: [], draftedIds: new Set() }), false);
});

test("draftOrderEntries flags the on-clock manager for the current round", () => {
  const entries = draftOrderEntries([1, 2, 3], 1, 2, 2);
  assert.deepEqual(
    entries.map((e) => e.userId),
    [1, 2, 3],
  );
  const onClock = entries.filter((e) => e.isOnClock);
  assert.deepEqual(onClock.map((e) => e.userId), [2]);
});

test("draftOrderEntries flags the next pick even across a snake reversal", () => {
  // 3 members, round 1 order [1,2,3]; pick 3 (last of round 1) is on the clock for
  // user 3, and the next overall pick (4) belongs to user 3 again (round 2 reverses
  // to [3,2,1]) - so "next" here is a repeat picker, not a new face.
  const entries = draftOrderEntries([1, 2, 3], 1, 3, 3);
  const onClock = entries.find((e) => e.isOnClock);
  assert.equal(onClock.userId, 3);
  // The next picker (round 2, pickInRound 1) is also user 3, so nothing else in
  // round 1's strip should be marked "next".
  assert.equal(entries.some((e) => e.isNext), false);
});

test("draftOrderEntries flags a genuinely different next picker mid-round", () => {
  const entries = draftOrderEntries([1, 2, 3], 1, 1, 1);
  const next = entries.find((e) => e.isNext);
  assert.equal(next.userId, 2);
});

// -- reduceDraftMessage ----------------------------------------------------------

function stateMessage(overrides = {}) {
  return {
    type: "state",
    leagueId: 1,
    status: "drafting",
    memberIds: [1, 2, 3],
    overallPick: 1,
    totalPicks: 45,
    onClockUserId: 1,
    round: 1,
    pickInRound: 1,
    picks: [],
    rosters: { 1: [], 2: [], 3: [] },
    ...overrides,
  };
}

test("reduceDraftMessage ignores pick/clock/complete/error before any state baseline", () => {
  assert.equal(reduceDraftMessage(null, { type: "pick", overallPick: 1, userId: 1, player: player(1, "GK") }), null);
  assert.equal(reduceDraftMessage(null, { type: "clock", onClockUserId: 1 }), null);
  assert.equal(reduceDraftMessage(null, { type: "complete" }), null);
  assert.equal(reduceDraftMessage(null, { type: "error", error: "boom" }), null);
});

test("reduceDraftMessage seeds room state from the first state message", () => {
  const next = reduceDraftMessage(null, stateMessage());
  assert.equal(next.status, "drafting");
  assert.equal(next.onClockUserId, 1);
  assert.equal(next.lastError, null);
});

test("reduceDraftMessage nulls onClockUserId on a pick, until the paired clock message names the next manager", () => {
  const seeded = reduceDraftMessage(null, stateMessage());
  const picked = reduceDraftMessage(seeded, {
    type: "pick",
    round: 1,
    pickInRound: 1,
    overallPick: 1,
    userId: 1,
    player: player(1, "GK"),
  });
  assert.equal(picked.onClockUserId, null);
  assert.equal(picked.overallPick, 2);
  assert.equal(picked.picks.length, 1);
  assert.deepEqual(picked.rosters[1], [player(1, "GK")]);

  const clocked = reduceDraftMessage(picked, {
    type: "clock",
    deadline: Date.now() + 60000,
    onClockUserId: 2,
    overallPick: 2,
    round: 1,
    pickInRound: 2,
  });
  assert.equal(clocked.onClockUserId, 2);
  // The pick and roster history from the earlier pick must survive a clock update.
  assert.equal(clocked.picks.length, 1);
  assert.deepEqual(clocked.rosters[1], [player(1, "GK")]);
});

test("reduceDraftMessage appends to existing rosters rather than replacing them", () => {
  let room = reduceDraftMessage(null, stateMessage());
  room = reduceDraftMessage(room, { type: "pick", round: 1, pickInRound: 1, overallPick: 1, userId: 1, player: player(1, "GK") });
  room = reduceDraftMessage(room, { type: "clock", onClockUserId: 2, overallPick: 2, round: 1, pickInRound: 2 });
  room = reduceDraftMessage(room, { type: "pick", round: 1, pickInRound: 2, overallPick: 2, userId: 1, player: player(2, "DEF") });
  assert.deepEqual(
    room.rosters[1].map((p) => p.id),
    [1, 2],
  );
});

test("reduceDraftMessage stashes an error and clears it on the next pick", () => {
  let room = reduceDraftMessage(null, stateMessage());
  room = reduceDraftMessage(room, { type: "error", error: "not your turn" });
  assert.equal(room.lastError, "not your turn");
  room = reduceDraftMessage(room, { type: "pick", round: 1, pickInRound: 1, overallPick: 1, userId: 1, player: player(1, "GK") });
  assert.equal(room.lastError, null);
});

test("reduceDraftMessage stashes an error and clears it on the next clock", () => {
  let room = reduceDraftMessage(null, stateMessage());
  room = reduceDraftMessage(room, { type: "error", error: "player already drafted" });
  assert.equal(room.lastError, "player already drafted");
  room = reduceDraftMessage(room, { type: "clock", onClockUserId: 2, overallPick: 2, round: 1, pickInRound: 2 });
  assert.equal(room.lastError, null);
});

test("reduceDraftMessage clears a stale error on a fresh state resync", () => {
  let room = reduceDraftMessage(null, stateMessage());
  room = reduceDraftMessage(room, { type: "error", error: "stale" });
  assert.equal(room.lastError, "stale");
  room = reduceDraftMessage(room, stateMessage({ onClockUserId: 2 }));
  assert.equal(room.lastError, null);
});

test("reduceDraftMessage marks the room complete while preserving its final rosters", () => {
  let room = reduceDraftMessage(null, stateMessage());
  room = reduceDraftMessage(room, { type: "pick", round: 1, pickInRound: 1, overallPick: 1, userId: 1, player: player(1, "GK") });
  room = reduceDraftMessage(room, { type: "complete" });
  assert.equal(room.status, "complete");
  assert.deepEqual(room.rosters[1], [player(1, "GK")]);
});
