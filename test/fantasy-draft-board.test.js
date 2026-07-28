import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_NOTE_LENGTH,
  activeTier,
  applyRankingImport,
  boardRows,
  boundedEditDistance,
  buildNameIndex,
  cleanNote,
  effectiveOrder,
  emptyBoard,
  isCustomBoard,
  matchPlayerName,
  moveBoardPlayer,
  moveBoardPlayerToTop,
  normalizeBoard,
  normalizeName,
  parseRankingImport,
  rankedPoolFor,
  resetBoard,
  resolveRankingImport,
  setBoardNote,
  tierSummaries,
  toggleTierBreak,
  withBoardAnnotations,
} from "../src/fantasyDraftBoard.js";

// A tiny pool whose value-over-replacement order is unambiguous, so a test
// asserting "the default board is the app's ranking" is asserting something
// checkable rather than restating rankDraftPool's output.
function pool() {
  return [
    { id: 1, name: "Mohamed Salah", team: "Liverpool", position: "MID", xp: 9 },
    { id: 2, name: "Erling Haaland", team: "Man City", position: "FWD", xp: 8 },
    { id: 3, name: "Bukayo Saka", team: "Arsenal", position: "MID", xp: 7 },
    { id: 4, name: "William Saliba", team: "Arsenal", position: "DEF", xp: 6 },
    { id: 5, name: "Alisson", team: "Liverpool", position: "GK", xp: 5 },
  ];
}

function ranked() {
  return rankedPoolFor(pool(), 4);
}

function idsOf(board, rankedPlayers = ranked()) {
  return boardRows(board, rankedPlayers).map((row) => row.playerId);
}

// -- The default board is the app's own ranking --------------------------------

test("an untouched board is exactly the value-over-replacement order, not a copy of it", () => {
  const rankedPlayers = ranked();
  assert.equal(isCustomBoard(emptyBoard()), false);
  assert.deepEqual(effectiveOrder(emptyBoard(), rankedPlayers), rankedPlayers.map((player) => player.id));
  // And it tracks the ranking rather than freezing it: a pool ranked for a
  // different league size re-orders the board with no stored state changed.
  const smallLeague = rankedPoolFor(pool(), 1);
  assert.deepEqual(effectiveOrder(emptyBoard(), smallLeague), smallLeague.map((player) => player.id));
});

test("a board keeps its own order and appends players the pool has since gained", () => {
  const board = { order: [3, 1], tierBreaks: [], notes: {} };
  const rankedPlayers = ranked();
  const order = effectiveOrder(board, rankedPlayers);
  assert.deepEqual(order.slice(0, 2), [3, 1]);
  assert.equal(new Set(order).size, rankedPlayers.length);
});

test("a board entry the pool no longer carries is skipped, never rendered as a hole", () => {
  const board = { order: [99, 2, 1], tierBreaks: [], notes: {} };
  assert.deepEqual(idsOf(board).slice(0, 2), [2, 1]);
  assert.equal(boardRows(board, ranked()).length, 5);
});

// -- Reordering ------------------------------------------------------------------

test("moving a player up and down swaps him one slot and materialises the order", () => {
  const moved = moveBoardPlayer(emptyBoard(), ranked(), 3, "up");
  assert.deepEqual(idsOf(moved), [1, 3, 2, 4, 5]);
  assert.equal(isCustomBoard(moved), true);

  const back = moveBoardPlayer(moved, ranked(), 3, "down");
  assert.deepEqual(idsOf(back), [1, 2, 3, 4, 5]);
});

test("moving past either end, or moving a player the pool does not have, is a no-op", () => {
  const board = emptyBoard();
  assert.equal(moveBoardPlayer(board, ranked(), 1, "up"), board);
  assert.equal(moveBoardPlayer(board, ranked(), 5, "down"), board);
  assert.equal(moveBoardPlayer(board, ranked(), 999, "up"), board);
  assert.equal(moveBoardPlayerToTop(board, ranked(), 1), board);
});

test("move-to-top lifts a player from anywhere without disturbing the rest of the order", () => {
  const moved = moveBoardPlayerToTop(emptyBoard(), ranked(), 5);
  assert.deepEqual(idsOf(moved), [5, 1, 2, 3, 4]);
});

// -- Tiers -------------------------------------------------------------------------

test("a tier break cuts the board into contiguous bands and counts what is left in each", () => {
  const board = toggleTierBreak(toggleTierBreak(emptyBoard(), ranked(), 3), ranked(), 5);
  const rows = boardRows(board, ranked(), new Set([2]));
  assert.deepEqual(
    rows.map((row) => row.tier),
    [1, 1, 2, 2, 3],
  );
  assert.deepEqual(tierSummaries(rows), [
    { tier: 1, total: 2, remaining: 1 }, // Haaland (id 2) is gone
    { tier: 2, total: 2, remaining: 2 },
    { tier: 3, total: 1, remaining: 1 },
  ]);
});

test("the top of the board always begins tier 1, so a break there is refused", () => {
  const board = emptyBoard();
  assert.equal(toggleTierBreak(board, ranked(), 1), board);
});

test("toggling a tier break twice removes it", () => {
  const on = toggleTierBreak(emptyBoard(), ranked(), 3);
  const off = toggleTierBreak(on, ranked(), 3);
  assert.deepEqual(
    boardRows(off, ranked()).map((row) => row.tier),
    [1, 1, 1, 1, 1],
  );
});

test("activeTier names the tier the next pick comes from, and how many of it survive", () => {
  const board = toggleTierBreak(emptyBoard(), ranked(), 3);
  assert.deepEqual(activeTier(boardRows(board, ranked(), new Set())), { tier: 1, total: 2, remaining: 2 });
  // Both of tier 1 gone: the live tier moves on rather than reporting zero.
  assert.deepEqual(activeTier(boardRows(board, ranked(), new Set([1, 2]))), { tier: 2, total: 3, remaining: 3 });
  assert.equal(activeTier(boardRows(board, ranked(), new Set([1, 2, 3, 4, 5]))), null);
});

// -- Taken players survive ---------------------------------------------------------

test("a drafted player stays exactly where the manager put him, marked taken", () => {
  const board = moveBoardPlayerToTop(emptyBoard(), ranked(), 4);
  const rows = boardRows(board, ranked(), new Set([4, 2]));
  assert.deepEqual(rows.map((row) => row.playerId), [4, 1, 2, 3, 5]);
  assert.deepEqual(rows.map((row) => row.taken), [true, false, true, false, false]);
});

// -- Notes ---------------------------------------------------------------------------

test("a note is cleaned, capped and attached to the player, and clearing it removes the key", () => {
  const withNote = setBoardNote(emptyBoard(), 2, "  Penalties\nand set pieces  ");
  assert.equal(withNote.notes["2"], "Penalties and set pieces");
  assert.equal(boardRows(withNote, ranked())[1].note, "Penalties and set pieces");

  const cleared = setBoardNote(withNote, 2, "   ");
  assert.deepEqual(cleared.notes, {});
});

test("cleanNote strips control characters and angle brackets and caps the length", () => {
  assert.equal(cleanNote("a<b>c"), "a b c");
  assert.equal(cleanNote("x".repeat(MAX_NOTE_LENGTH + 40)).length, MAX_NOTE_LENGTH);
  assert.equal(cleanNote(null), "");
});

test("resetting returns the app's ranking and drops the manager's tiers and notes", () => {
  const board = setBoardNote(toggleTierBreak(moveBoardPlayerToTop(emptyBoard(), ranked(), 5), ranked(), 2), 5, "sleeper");
  assert.equal(isCustomBoard(board), true);
  const reset = resetBoard();
  assert.equal(isCustomBoard(reset), false);
  assert.deepEqual(idsOf(reset), [1, 2, 3, 4, 5]);
});

// -- normalizeBoard ------------------------------------------------------------------

test("normalizeBoard turns anything unusable from storage into an untouched board", () => {
  assert.deepEqual(normalizeBoard(null), emptyBoard());
  assert.deepEqual(normalizeBoard("nonsense"), emptyBoard());
  assert.deepEqual(normalizeBoard({ order: "nope", tierBreaks: 4, notes: 7 }), emptyBoard());
  assert.deepEqual(normalizeBoard({ order: [1, null, 2], tierBreaks: [2], notes: { 2: "  hi  ", 3: "   " } }), {
    order: [1, 2],
    tierBreaks: [2],
    notes: { 2: "hi" },
  });
});

// -- Import parsing --------------------------------------------------------------------

test("parseRankingImport reads bare names, numbered lists, CSV/TSV rows and tier markers", () => {
  const entries = parseRankingImport(
    [
      "Mohamed Salah",
      "2. Erling Haaland",
      "3) Bukayo Saka",
      "Tier 2",
      "William Saliba,Arsenal,DEF",
      "5\tAlisson\tLiverpool",
      "-----",
      "Kevin De Bruyne (MCI - MID)",
      "",
      "   ",
    ].join("\n"),
  );
  assert.deepEqual(entries, [
    { kind: "player", name: "Mohamed Salah" },
    { kind: "player", name: "Erling Haaland" },
    { kind: "player", name: "Bukayo Saka" },
    { kind: "tier" },
    { kind: "player", name: "William Saliba" },
    { kind: "player", name: "Alisson" },
    { kind: "tier" },
    { kind: "player", name: "Kevin De Bruyne" },
  ]);
});

// -- Name matching -----------------------------------------------------------------------

test("normalizeName flattens case, accents and punctuation", () => {
  assert.equal(normalizeName("Ødegaard"), "degaard"); // O-slash is not a combining mark
  assert.equal(normalizeName("N'Golo  Kanté"), "n golo kante");
  assert.equal(normalizeName("  SALAH, M.  "), "salah m");
});

test("boundedEditDistance bails out rather than paying for a distance nobody will accept", () => {
  assert.equal(boundedEditDistance("salah", "salah", 2), 0);
  assert.equal(boundedEditDistance("salah", "sallah", 2), 1);
  assert.equal(boundedEditDistance("salah", "haaland", 2), 3); // limit + 1, not the true distance
});

test("matchPlayerName resolves exact names, surnames and initial-plus-surname forms", () => {
  const index = buildNameIndex(pool());
  assert.equal(matchPlayerName("mohamed salah", index).player.id, 1);
  assert.equal(matchPlayerName("Haaland", index).player.id, 2);
  assert.equal(matchPlayerName("M. Salah", index).player.id, 1);
  assert.equal(matchPlayerName("Mo Salah", index).player.id, 1);
});

test("matchPlayerName absorbs a misspelling but refuses to guess between two real players", () => {
  const index = buildNameIndex([
    ...pool(),
    { id: 6, name: "Ben White", team: "Arsenal", position: "DEF", xp: 4 },
    { id: 7, name: "Joe White", team: "Everton", position: "DEF", xp: 4 },
  ]);
  assert.equal(matchPlayerName("Mohammed Salah", index).player.id, 1);
  assert.equal(matchPlayerName("Erling Halland", index).player.id, 2);

  const ambiguous = matchPlayerName("White", index);
  assert.equal(ambiguous.player, undefined);
  assert.equal(ambiguous.reason, "ambiguous");
});

test("matchPlayerName reports a name the pool simply does not have", () => {
  const result = matchPlayerName("Cristiano Ronaldo", buildNameIndex(pool()));
  assert.equal(result.player, undefined);
  assert.equal(result.reason, "no match");
});

// -- The whole import ------------------------------------------------------------------

test("resolveRankingImport accounts for every line: matched, duplicated or reported", () => {
  const resolved = resolveRankingImport(
    ["Salah", "Tier 2", "Haaland", "Zlatan Ibrahimovic", "Mo Salah", "Saliba"].join("\n"),
    pool(),
  );
  assert.deepEqual(resolved.order, [1, 2, 4]);
  assert.deepEqual(resolved.tierBreakIds, [2]);
  assert.deepEqual(
    resolved.unmatched.map((entry) => entry.name),
    ["Zlatan Ibrahimovic"],
  );
  assert.deepEqual(
    resolved.duplicates.map((entry) => entry.name),
    ["Mo Salah"],
  );
});

test("a tier marker before the first matched name is a heading for tier 1, not an empty tier", () => {
  const resolved = resolveRankingImport(["Tier 1", "Salah", "Haaland"].join("\n"), pool());
  assert.deepEqual(resolved.tierBreakIds, []);
});

test("importing a partial ranking keeps the unlisted players below it rather than dropping them", () => {
  const resolved = resolveRankingImport(["Alisson", "Tier 2", "Saka"].join("\n"), pool());
  const board = applyRankingImport(emptyBoard(), ranked(), resolved);
  assert.deepEqual(idsOf(board), [5, 3, 1, 2, 4]);
  assert.deepEqual(
    boardRows(board, ranked()).map((row) => row.tier),
    [1, 2, 2, 2, 2],
  );
});

test("an import replaces the ordering and the tier cuts but keeps the notes", () => {
  const before = setBoardNote(toggleTierBreak(emptyBoard(), ranked(), 4), 2, "watch his minutes");
  const resolved = resolveRankingImport(["Haaland", "Salah"].join("\n"), pool());
  const after = applyRankingImport(before, ranked(), resolved);
  assert.deepEqual(after.tierBreaks, []);
  assert.equal(after.notes["2"], "watch his minutes");
  assert.deepEqual(idsOf(after).slice(0, 2), [2, 1]);
});

// -- Pool annotation -----------------------------------------------------------------

test("withBoardAnnotations stamps rank, tier and note without mutating the ranked pool", () => {
  const board = setBoardNote(toggleTierBreak(moveBoardPlayerToTop(emptyBoard(), ranked(), 5), ranked(), 1), 5, "elite");
  const rankedPlayers = ranked();
  const annotated = withBoardAnnotations(rankedPlayers, board, new Set());

  const alisson = annotated.find((player) => player.id === 5);
  assert.equal(alisson.boardRank, 1);
  assert.equal(alisson.boardTier, 1);
  assert.equal(alisson.boardNote, "elite");
  assert.equal(annotated.find((player) => player.id === 1).boardTier, 2);
  assert.equal(rankedPlayers.find((player) => player.id === 5).boardRank, undefined);
});

test("a single pasted word matches a player the pool lists under his first name", () => {
  // The squad bake abbreviates most given names ("C. Palmer") but stores a
  // handful of players under a full or mononym name ("Alisson Becker").
  const index = buildNameIndex([
    { id: 1, name: "Alisson Becker", team: "Liverpool", position: "GK" },
    { id: 2, name: "C. Palmer", team: "Chelsea", position: "MID" },
  ]);
  assert.equal(matchPlayerName("Alisson", index).player.id, 1);
});

test("a first name breaks a tie between two same-surname players the pool abbreviates", () => {
  const index = buildNameIndex([
    { id: 1, name: "C. Palmer", team: "Chelsea", position: "MID" },
    { id: 2, name: "A. Palmer", team: "Everton", position: "DEF" },
  ]);
  // Exact surname, both candidates: the initial decides.
  assert.equal(matchPlayerName("Cole Palmer", index).player.id, 1);
  // And it still decides after a misspelling has already gone through the
  // fuzzy rung, which is where both were one edit away from the paste.
  assert.equal(matchPlayerName("Cole Palmar", index).player.id, 1);
  // No first name to go on, so it stays an honest ambiguity.
  assert.equal(matchPlayerName("Palmer", index).reason, "ambiguous");
});
