import assert from "node:assert/strict";
import test from "node:test";

import { canDraftPlayer, draftOrderEntries, formatCountdown, squadBucketCounts } from "../src/fantasyDraft.js";

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
