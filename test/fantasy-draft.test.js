import assert from "node:assert/strict";
import test from "node:test";

import {
  canDraftPlayer,
  currentSeasonLabel,
  draftOrderEntries,
  formatCountdown,
  formatOrdinal,
  formatPickNumber,
  formSparklineBars,
  normalizePlayerStats,
  reduceDraftMessage,
  squadBucketCounts,
  suggestedPick,
  suggestedPickReason,
} from "../src/fantasyDraft.js";

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

// -- formatPickNumber --------------------------------------------------------------

test("formatPickNumber renders round.pickInRound with the pick zero-padded to two digits", () => {
  assert.equal(formatPickNumber(1, 1), "1.01");
  assert.equal(formatPickNumber(2, 8), "2.08");
  assert.equal(formatPickNumber(3, 12), "3.12");
});

// -- currentSeasonLabel -------------------------------------------------------------

test("currentSeasonLabel reads a July-or-later date as the season starting that year", () => {
  assert.equal(currentSeasonLabel(new Date(2026, 6, 23)), "2026/27");
  assert.equal(currentSeasonLabel(new Date(2026, 11, 1)), "2026/27");
});

test("currentSeasonLabel reads a date before July as still part of the previous year's season", () => {
  assert.equal(currentSeasonLabel(new Date(2027, 0, 15)), "2026/27");
  assert.equal(currentSeasonLabel(new Date(2027, 5, 30)), "2026/27");
});

// -- suggestedPick -------------------------------------------------------------------

test("suggestedPick defers to autoPick's scarcest-bucket-first rule for an empty roster", () => {
  const pool = [player(1, "GK"), player(2, "DEF"), player(3, "MID"), player(4, "FWD")];
  const suggestion = suggestedPick(pool, [], new Set());
  // GK has the smallest cap (2), so an empty roster's scarcest bucket is GK.
  assert.equal(suggestion.id, 1);
});

test("suggestedPick excludes players already drafted anywhere in the league", () => {
  const pool = [player(1, "GK"), player(2, "GK")];
  const suggestion = suggestedPick(pool, [], new Set([1]));
  assert.equal(suggestion.id, 2);
});

test("suggestedPick skips a bucket that is already full on the caller's roster", () => {
  const myRoster = [player(10, "GK"), player(11, "GK")]; // GK cap is 2, now full
  const pool = [player(1, "GK"), player(2, "FWD")];
  const suggestion = suggestedPick(pool, myRoster, new Set());
  assert.equal(suggestion.id, 2);
});

test("suggestedPick returns null once no legal candidate remains", () => {
  const myRoster = [player(10, "GK"), player(11, "GK")];
  const pool = [player(1, "GK")]; // only a GK left, but that bucket is full
  const suggestion = suggestedPick(pool, myRoster, new Set());
  assert.equal(suggestion, null);
});

// -- formatOrdinal ------------------------------------------------------------------

test("formatOrdinal appends st/nd/rd/th following English rules", () => {
  assert.equal(formatOrdinal(1), "1st");
  assert.equal(formatOrdinal(2), "2nd");
  assert.equal(formatOrdinal(3), "3rd");
  assert.equal(formatOrdinal(4), "4th");
});

test("formatOrdinal treats 11-13 as th regardless of the last digit", () => {
  assert.equal(formatOrdinal(11), "11th");
  assert.equal(formatOrdinal(12), "12th");
  assert.equal(formatOrdinal(13), "13th");
  assert.equal(formatOrdinal(21), "21st");
  assert.equal(formatOrdinal(112), "112th");
});

// -- normalizePlayerStats -----------------------------------------------------------

test("normalizePlayerStats passes through finite numeric fields", () => {
  const stats = normalizePlayerStats({ avg: 5.9, xp: 7.8, adp: 19, form: [4, 7, 3, 9, 6] });
  assert.deepEqual(stats, { avg: 5.9, form: [4, 7, 3, 9, 6], xp: 7.8, adp: 19 });
});

test("normalizePlayerStats treats missing or non-numeric fields as null, never a fabricated number", () => {
  const stats = normalizePlayerStats({ name: "No stats yet" });
  assert.deepEqual(stats, { avg: null, form: null, xp: null, adp: null });
});

test("normalizePlayerStats rejects NaN/Infinity and non-array form", () => {
  const stats = normalizePlayerStats({ avg: NaN, xp: Infinity, adp: "19", form: "WWDLW" });
  assert.deepEqual(stats, { avg: null, form: null, xp: null, adp: null });
});

test("normalizePlayerStats drops non-numeric entries out of a form array rather than failing the whole field", () => {
  const stats = normalizePlayerStats({ form: [4, "x", 6, null, 9] });
  assert.deepEqual(stats.form, [4, 6, 9]);
});

// -- formSparklineBars ---------------------------------------------------------------

test("formSparklineBars scales bar heights relative to this player's own max", () => {
  const bars = formSparklineBars([2, 4, 8, 4, 2]);
  assert.equal(bars.length, 5);
  assert.equal(bars[2].height, 1); // the max value is always a full bar
  assert.equal(bars[0].height, 0.25);
});

test("formSparklineBars marks bars at or above 60% of the max as strong", () => {
  const bars = formSparklineBars([10, 5, 6, 3, 1]);
  assert.deepEqual(bars.map((b) => b.strong), [true, false, true, false, false]);
});

test("formSparklineBars keeps only the 5 most recent values", () => {
  const bars = formSparklineBars([1, 2, 3, 4, 5, 6, 7]);
  assert.equal(bars.length, 5);
  assert.equal(bars[4].height, 1); // 7 is the most recent and the max of the kept slice
});

test("formSparklineBars returns an empty array for missing form data (the view renders a placeholder)", () => {
  assert.deepEqual(formSparklineBars(null), []);
  assert.deepEqual(formSparklineBars(undefined), []);
  assert.deepEqual(formSparklineBars([]), []);
});

// -- suggestedPickReason -------------------------------------------------------------

test("suggestedPickReason names the scarcest bucket and remaining slots, honestly noting no xP data", () => {
  const reason = suggestedPickReason(player(1, "FWD"), []);
  assert.match(reason, /scarcest open slot: FWD/);
  assert.match(reason, /3 of 3 remaining/);
  assert.match(reason, /First available FWD in the pool\./);
});

test("suggestedPickReason reflects a partially-filled bucket's remaining count", () => {
  const myRoster = [player(20, "FWD")];
  const reason = suggestedPickReason(player(1, "FWD"), myRoster);
  assert.match(reason, /2 of 3 remaining/);
});

test("suggestedPickReason cites the real xP figure instead of pool order when the player has one", () => {
  const withXp = { id: 1, position: "FWD", name: "Test", team: "Test FC", xp: 7.8 };
  const reason = suggestedPickReason(withXp, []);
  assert.match(reason, /Highest listed expected points for FWD\./);
});

test("suggestedPickReason returns an empty string for a null player", () => {
  assert.equal(suggestedPickReason(null, []), "");
});
