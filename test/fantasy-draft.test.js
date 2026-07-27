import assert from "node:assert/strict";
import test from "node:test";

import {
  addToQueue,
  applyBlendedXp,
  canDraftPlayer,
  currentSeasonLabel,
  draftOrderEntries,
  formatCountdown,
  formatOrdinal,
  formatPickNumber,
  hasPriorSeasonData,
  legalSwapTargets,
  matchupBarWidths,
  matchupLeadSide,
  moveQueueItem,
  normalizePlayerStats,
  priorSeasonRangeLabel,
  pruneQueue,
  queueEntries,
  reduceDraftMessage,
  removeFromQueue,
  squadBucketCounts,
  suggestedPick,
  suggestedPickReason,
  swapLineup,
  tierLabel,
  toggleQueue,
  topQueuedPick,
  xpSeasonsLabel,
  xpTooltip,
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
// Deliberately widened to also carry xpBasis (data/PL/players.json's
// "history" | "estimate" | null, see src/fantasyExpectedPoints.js's
// expectedPointsFor), so a renderer can distinguish a measured figure from a
// cohort estimate - see xpBadge/xpTooltip in fantasyView.js/fantasyDraft.js.

test("normalizePlayerStats passes through a finite xp field and its basis", () => {
  const stats = normalizePlayerStats({ xp: 7.8, xpBasis: "history" });
  assert.deepEqual(stats, { xp: 7.8, xpBasis: "history" });
});

test("normalizePlayerStats treats a missing or non-numeric xp as null, never a fabricated number", () => {
  assert.deepEqual(normalizePlayerStats({ name: "No stats yet" }), { xp: null, xpBasis: null });
  assert.deepEqual(normalizePlayerStats({ xp: Infinity }), { xp: null, xpBasis: null });
  assert.deepEqual(normalizePlayerStats({ xp: NaN }), { xp: null, xpBasis: null });
  assert.deepEqual(normalizePlayerStats({ xp: "7.8" }), { xp: null, xpBasis: null });
});

test("normalizePlayerStats never attaches a basis to a null xp, even if the source object carries one", () => {
  assert.deepEqual(normalizePlayerStats({ xp: null, xpBasis: "estimate" }), { xp: null, xpBasis: null });
});

test("normalizePlayerStats falls back to a null basis for a non-string xpBasis", () => {
  assert.deepEqual(normalizePlayerStats({ xp: 4, xpBasis: 123 }), { xp: 4, xpBasis: null });
});

// -- hasPriorSeasonData -------------------------------------------------------------

test("hasPriorSeasonData is true once any player carries a tier field", () => {
  assert.equal(hasPriorSeasonData([{ id: 1, tier: "starter" }, { id: 2 }]), true);
});

test("hasPriorSeasonData is true for a player whose tier is explicitly unknown (no prior record, not a failed bake)", () => {
  assert.equal(hasPriorSeasonData([{ id: 1, tier: "unknown", appearances: null }]), true);
});

test("hasPriorSeasonData is false for an empty pool or one where no player carries a tier field at all", () => {
  assert.equal(hasPriorSeasonData([]), false);
  assert.equal(hasPriorSeasonData(null), false);
  assert.equal(hasPriorSeasonData([{ id: 1, name: "Pre-enrichment player" }]), false);
});

// -- tierLabel ----------------------------------------------------------------------

test("tierLabel renders the known tiers as plain fact", () => {
  assert.equal(tierLabel("starter"), "Starter");
  assert.equal(tierLabel("squad"), "Squad");
  assert.equal(tierLabel("fringe"), "Fringe");
});

test("tierLabel renders an explicit 'unknown' (no prior-season record) as New, not zero or blank", () => {
  assert.equal(tierLabel("unknown"), "New");
});

test("tierLabel returns null for a missing or unrecognised tier so the caller renders nothing", () => {
  assert.equal(tierLabel(undefined), null);
  assert.equal(tierLabel(null), null);
  assert.equal(tierLabel("legend"), null);
});

// -- applyBlendedXp -----------------------------------------------------------------

test("applyBlendedXp overlays a fresher xp/xpBasis onto the matching player id", () => {
  const players = [{ id: 1, xp: 3, xpBasis: "history" }, { id: 2, xp: 1, xpBasis: "estimate" }];
  const blended = { 1: { xp: 5.5, xpBasis: "blended" } };
  const result = applyBlendedXp(players, blended);
  assert.deepEqual(result[0], { id: 1, xp: 5.5, xpBasis: "blended" });
  assert.deepEqual(result[1], players[1]); // player 2 untouched: no blended entry for them
});

test("applyBlendedXp leaves the pool completely unchanged when there is nothing to overlay with", () => {
  const players = [{ id: 1, xp: 3 }];
  assert.equal(applyBlendedXp(players, null), players);
  assert.equal(applyBlendedXp(players, undefined), players);
});

test("applyBlendedXp ignores a blended entry whose own xp is null, keeping the pool's baked figure", () => {
  const players = [{ id: 1, xp: 3, xpBasis: "history" }];
  const result = applyBlendedXp(players, { 1: { xp: null, xpBasis: "blended" } });
  assert.deepEqual(result[0], players[0]);
});

test("applyBlendedXp does not mutate its input players array", () => {
  const players = [{ id: 1, xp: 3, xpBasis: "history" }];
  applyBlendedXp(players, { 1: { xp: 9, xpBasis: "blended" } });
  assert.equal(players[0].xp, 3);
});

// -- xpSeasonsLabel / xpTooltip -------------------------------------------------------

test("xpSeasonsLabel joins multiple season-start years into a readable range list", () => {
  assert.equal(xpSeasonsLabel(["2025", "2024", "2023"]), "2025/26, 2024/25, 2023/24");
  assert.equal(xpSeasonsLabel([]), "");
  assert.equal(xpSeasonsLabel(null), "");
});

test("xpTooltip names the projection and the peer position for an estimate, never as a personal record", () => {
  const text = xpTooltip("estimate", { position: "MID" });
  assert.match(text, /estimat/i);
  assert.match(text, /MID/);
  assert.match(text, /not this player's own record/);
});

test("xpTooltip names the seasons behind a measured history figure", () => {
  assert.equal(xpTooltip("history", { seasons: ["2025", "2024"] }), "From actual history: 2025/26, 2024/25.");
});

test("xpTooltip names the seasons behind a blended figure too", () => {
  assert.match(xpTooltip("blended", { seasons: ["2025"] }), /blended with actual history \(2025\/26\)/);
});

test("xpTooltip returns an empty string when there is no basis to explain", () => {
  assert.equal(xpTooltip(null), "");
  assert.equal(xpTooltip(undefined), "");
});

// -- priorSeasonRangeLabel -----------------------------------------------------------

test("priorSeasonRangeLabel formats a starting year as a season range", () => {
  assert.equal(priorSeasonRangeLabel("2025"), "2025/26");
  assert.equal(priorSeasonRangeLabel(2019), "2019/20");
});

test("priorSeasonRangeLabel returns an empty string for a missing or invalid season", () => {
  assert.equal(priorSeasonRangeLabel(null), "");
  assert.equal(priorSeasonRangeLabel(undefined), "");
  assert.equal(priorSeasonRangeLabel("not-a-year"), "");
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

// -- swapLineup / legalSwapTargets (My team pitch editing) --------------------------

// GK1, DEF4, MID4, FWD2 starting (11), plus one bench player per position (4),
// matching the SQUAD_SLOTS totals a real 15-man roster would have.
function lineupRoster() {
  return [
    player(1, "GK"),
    player(2, "DEF"),
    player(3, "DEF"),
    player(4, "DEF"),
    player(5, "DEF"),
    player(6, "MID"),
    player(7, "MID"),
    player(8, "MID"),
    player(9, "MID"),
    player(10, "FWD"),
    player(11, "FWD"),
    player(12, "GK"), // bench
    player(13, "DEF"), // bench
    player(14, "MID"), // bench
    player(15, "FWD"), // bench
  ];
}

const STARTERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const BENCH = [12, 13, 14, 15];

test("swapLineup swaps a bench player in for a starter of the same position", () => {
  const roster = lineupRoster();
  const result = swapLineup({ starters: STARTERS, captainId: 10, bench: BENCH, roster }, 2, 13);
  assert.equal(result.ok, true);
  assert.deepEqual(result.starters, [1, 13, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(result.bench, [12, 2, 14, 15]);
  assert.equal(result.captainId, 10); // captain untouched by an unrelated swap
});

test("swapLineup reassigns captaincy to the incoming starter when the captain is benched", () => {
  const roster = lineupRoster();
  const result = swapLineup({ starters: STARTERS, captainId: 1, bench: BENCH, roster }, 1, 12);
  assert.equal(result.ok, true);
  assert.equal(result.captainId, 12); // GK captain swapped out; the new GK inherits the armband
});

test("swapLineup rejects swapping two starters (not one starter and one bench player)", () => {
  const roster = lineupRoster();
  const result = swapLineup({ starters: STARTERS, captainId: 10, bench: BENCH, roster }, 2, 3);
  assert.equal(result.ok, false);
  assert.match(result.error, /one starter and one bench player/);
});

test("swapLineup rejects swapping two bench players", () => {
  const roster = lineupRoster();
  const result = swapLineup({ starters: STARTERS, captainId: 10, bench: BENCH, roster }, 12, 13);
  assert.equal(result.ok, false);
  assert.match(result.error, /one starter and one bench player/);
});

test("swapLineup rejects a swap that would push a position outside its legal range", () => {
  // DEF is already at its floor of 3 in this fixture; bringing in a MID bench
  // player for one of them would drop DEF to 2.
  const roster = [
    player(1, "GK"),
    player(2, "DEF"),
    player(3, "DEF"),
    player(4, "DEF"),
    player(5, "MID"),
    player(6, "MID"),
    player(7, "MID"),
    player(8, "MID"),
    player(9, "MID"),
    player(10, "FWD"),
    player(11, "FWD"),
    player(12, "MID"), // bench
  ];
  const starters = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const result = swapLineup({ starters, captainId: 10, bench: [12], roster }, 2, 12);
  assert.equal(result.ok, false);
  assert.match(result.error, /DEF/);
});

test("swapLineup rejects an unknown player id", () => {
  const roster = lineupRoster();
  const result = swapLineup({ starters: STARTERS, captainId: 10, bench: BENCH, roster }, 2, 999);
  assert.equal(result.ok, false);
});

test("legalSwapTargets returns an empty set with no pending selection", () => {
  const roster = lineupRoster();
  const targets = legalSwapTargets({ starters: STARTERS, captainId: 10, bench: BENCH, roster }, null);
  assert.equal(targets.size, 0);
});

test("legalSwapTargets excludes the one starter whose position would drop below its minimum", () => {
  const roster = lineupRoster();
  // Bench player 13 is DEF; swapping it in for anyone except the sole GK
  // starter keeps every position within its legal range (DEF can rise to 5,
  // MID/FWD can fall by one and stay at or above their minimums) - only
  // benching the GK (dropping GK to 0) is illegal.
  const targets = legalSwapTargets({ starters: STARTERS, captainId: 10, bench: BENCH, roster }, 13);
  assert.equal(targets.has(1), false);
  for (const id of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) assert.equal(targets.has(id), true, `expected ${id} to be a legal target`);
});

test("legalSwapTargets is empty for a pending id not on either side of the lineup", () => {
  const roster = lineupRoster();
  const targets = legalSwapTargets({ starters: STARTERS, captainId: 10, bench: BENCH, roster }, 999);
  assert.equal(targets.size, 0);
});

// -- Matchup tab pure helpers (Phase 4.3) -----------------------------------------

test("matchupLeadSide picks the higher score's side", () => {
  assert.equal(matchupLeadSide(42, 37), "me");
  assert.equal(matchupLeadSide(37, 42), "opponent");
});

test("matchupLeadSide is tied on equal scores, including 0-0", () => {
  assert.equal(matchupLeadSide(10, 10), "tied");
  assert.equal(matchupLeadSide(0, 0), "tied");
});

test("matchupLeadSide treats missing scores as zero", () => {
  assert.equal(matchupLeadSide(undefined, undefined), "tied");
  assert.equal(matchupLeadSide(5, undefined), "me");
});

test("matchupBarWidths splits proportionally to the two scores and always sums to 100", () => {
  const widths = matchupBarWidths(75, 25);
  assert.equal(widths.me, 75);
  assert.equal(widths.opponent, 25);
  assert.equal(widths.me + widths.opponent, 100);
});

test("matchupBarWidths splits a scoreless matchup evenly instead of dividing by zero", () => {
  assert.deepEqual(matchupBarWidths(0, 0), { me: 50, opponent: 50 });
});

test("matchupBarWidths ignores negative input rather than producing an out-of-range width", () => {
  const widths = matchupBarWidths(-5, 10);
  assert.equal(widths.me, 0);
  assert.equal(widths.opponent, 100);
});

// -- Pick queue (personal shortlist) ---------------------------------------------

test("addToQueue appends a new id and is a no-op for one already queued", () => {
  const once = addToQueue([], 1);
  assert.deepEqual(once, [1]);
  const twice = addToQueue(once, 2);
  assert.deepEqual(twice, [1, 2]);
  assert.equal(addToQueue(twice, 1), twice, "re-adding an already-queued id returns the same reference");
});

test("addToQueue ignores a null/undefined id", () => {
  assert.deepEqual(addToQueue([1], null), [1]);
  assert.deepEqual(addToQueue([1], undefined), [1]);
});

test("removeFromQueue drops just the named id, keeping order for the rest", () => {
  assert.deepEqual(removeFromQueue([1, 2, 3], 2), [1, 3]);
  assert.deepEqual(removeFromQueue([1, 2, 3], 99), [1, 2, 3]);
});

test("toggleQueue adds an unqueued id and removes an already-queued one", () => {
  const added = toggleQueue([1], 2);
  assert.deepEqual(added, [1, 2]);
  const removed = toggleQueue(added, 1);
  assert.deepEqual(removed, [2]);
});

// -- moveQueueItem: reordering the queue ------------------------------------------

test("moveQueueItem swaps an entry one slot up or down", () => {
  assert.deepEqual(moveQueueItem([1, 2, 3], 2, "up"), [2, 1, 3]);
  assert.deepEqual(moveQueueItem([1, 2, 3], 2, "down"), [1, 3, 2]);
});

test("moveQueueItem is a no-op past either end of the queue", () => {
  const queue = [1, 2, 3];
  assert.equal(moveQueueItem(queue, 1, "up"), queue, "moving the first entry up is a no-op");
  assert.equal(moveQueueItem(queue, 3, "down"), queue, "moving the last entry down is a no-op");
});

test("moveQueueItem is a no-op for an id no longer in the queue", () => {
  const queue = [1, 2, 3];
  assert.equal(moveQueueItem(queue, 99, "up"), queue);
});

// -- queueEntries: display order with staleness -----------------------------------

test("queueEntries resolves each id to its player and preserves queue order", () => {
  const pool = [player(1, "GK"), player(2, "DEF"), player(3, "MID")];
  const entries = queueEntries([3, 1], pool, new Set());
  assert.deepEqual(
    entries.map((entry) => entry.playerId),
    [3, 1],
  );
  assert.equal(entries[0].player.id, 3);
  assert.equal(entries[0].available, true);
});

test("queueEntries marks a queued player taken by someone else as no longer available, rather than dropping it", () => {
  const pool = [player(1, "GK"), player(2, "DEF")];
  const entries = queueEntries([1, 2], pool, new Set([1]));
  assert.equal(entries.length, 2, "a taken entry stays in the list rather than disappearing");
  assert.equal(entries.find((entry) => entry.playerId === 1).available, false);
  assert.equal(entries.find((entry) => entry.playerId === 2).available, true);
});

test("queueEntries resolves a stale id no longer in the pool to a null player rather than throwing", () => {
  const entries = queueEntries([999], [], new Set());
  assert.equal(entries[0].player, null);
});

// -- pruneQueue: drop what I now own, keep what a rival took -----------------------

test("pruneQueue drops a queued player the manager drafted themselves", () => {
  assert.deepEqual(pruneQueue([1, 2, 3], [player(2, "DEF")]), [1, 3]);
});

test("pruneQueue keeps a queued player a rival drafted, so the manager still sees the loss", () => {
  // Only the manager's own roster prunes; a rival's pick is invisible here and
  // stays queued, where queueEntries marks it unavailable instead.
  assert.deepEqual(pruneQueue([1, 2], []), [1, 2]);
});

test("pruneQueue returns the same array reference when nothing was drafted, to avoid a pointless re-render", () => {
  const queue = [1, 2];
  assert.equal(pruneQueue(queue, [player(9, "MID")]), queue);
});

test("pruneQueue tolerates a null queue and a null roster", () => {
  assert.deepEqual(pruneQueue(null, null), []);
});

// -- topQueuedPick: the queue's best still-legal pick ------------------------------

test("topQueuedPick returns the first queued player who is both available and legal", () => {
  const pool = [player(1, "GK"), player(2, "DEF"), player(3, "MID")];
  const pick = topQueuedPick([1, 2, 3], pool, [], new Set());
  assert.equal(pick.id, 1, "the first entry in queue order wins when everything ahead of it is clear");
});

test("topQueuedPick skips a queued player already taken by someone else", () => {
  const pool = [player(1, "GK"), player(2, "DEF")];
  const pick = topQueuedPick([1, 2], pool, [], new Set([1]));
  assert.equal(pick.id, 2, "the taken 1st-queued player is skipped in favour of the next one");
});

test("topQueuedPick skips a queued player whose position bucket is now full on my roster", () => {
  const myRoster = [player(10, "GK"), player(11, "GK")]; // GK cap is 2, now full
  const pool = [player(1, "GK"), player(2, "DEF")];
  const pick = topQueuedPick([1, 2], pool, myRoster, new Set());
  assert.equal(pick.id, 2, "the GK is queued first but illegal now, so the next legal queued player wins");
});

test("topQueuedPick returns null once nothing in the queue is both available and legal", () => {
  const myRoster = [player(10, "GK"), player(11, "GK")];
  const pool = [player(1, "GK")];
  assert.equal(topQueuedPick([1], pool, myRoster, new Set()), null);
});

test("topQueuedPick returns null for an empty or unset queue", () => {
  const pool = [player(1, "GK")];
  assert.equal(topQueuedPick([], pool, [], new Set()), null);
  assert.equal(topQueuedPick(undefined, pool, [], new Set()), null);
});
