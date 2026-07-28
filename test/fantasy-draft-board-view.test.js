import test from "node:test";
import assert from "node:assert/strict";

import {
  emptyBoard,
  moveBoardPlayerToTop,
  rankedPoolFor,
  setBoardNote,
  toggleTierBreak,
} from "../src/fantasyDraftBoard.js";
import { renderBoardRows, renderFantasyBoardPanel } from "../src/fantasyDraftBoardView.js";

function pool() {
  return [
    { id: 1, name: "Mohamed Salah", team: "Liverpool", position: "MID", xp: 9 },
    { id: 2, name: "Erling Haaland", team: "Man City", position: "FWD", xp: 8 },
    { id: 3, name: "Bukayo Saka", team: "Arsenal", position: "MID", xp: 7 },
    { id: 4, name: "William Saliba", team: "Arsenal", position: "DEF", xp: 6 },
    { id: 5, name: "Alisson", team: "Liverpool", position: "GK", xp: 5 },
  ];
}

const ranked = () => rankedPoolFor(pool(), 4);

test("an untouched board says it is the app's ranking, and offers no reset", () => {
  const html = renderFantasyBoardPanel(emptyBoard(), ranked());
  assert.match(html, /ranked by value over replacement until you change it/);
  assert.doesNotMatch(html, /data-board-reset/);
});

test("once customised the board says so and offers a reset back to value order", () => {
  const html = renderFantasyBoardPanel(moveBoardPlayerToTop(emptyBoard(), ranked(), 5), ranked());
  assert.match(html, /5 players, your order/);
  assert.match(html, /data-board-reset/);
});

test("tier headings carry how many of the tier are still undrafted", () => {
  const board = toggleTierBreak(emptyBoard(), ranked(), 3);
  const html = renderBoardRows(board, ranked(), { draftedIds: new Set([1]) });
  assert.match(html, /Tier 1<\/span>\s*<span class="fantasy-board-tier__count">1 of 2 left/);
  assert.match(html, /Tier 2<\/span>\s*<span class="fantasy-board-tier__count">3 of 3 left/);
});

test("a tier down to three or fewer is marked as a cliff, a fuller one is not", () => {
  const players = Array.from({ length: 10 }, (_, index) => ({
    id: index + 1,
    name: `Player ${index + 1}`,
    team: "Arsenal",
    position: "MID",
    xp: 100 - index,
  }));
  const rankedPlayers = rankedPoolFor(players, 4);
  const board = toggleTierBreak(emptyBoard(), rankedPlayers, 6); // two tiers of five
  assert.doesNotMatch(renderBoardRows(board, rankedPlayers, { draftedIds: new Set() }), /is-cliff/);
  // Two of the first tier gone leaves three, which is where a tier stops
  // being a grouping and starts being a deadline.
  assert.match(renderBoardRows(board, rankedPlayers, { draftedIds: new Set([1, 2]) }), /is-cliff/);
});

test("a drafted player is marked Gone and struck through, never dropped from the board", () => {
  const html = renderBoardRows(emptyBoard(), ranked(), { draftedIds: new Set([2]) });
  assert.match(html, /is-taken/);
  assert.match(html, /Erling Haaland/);
  assert.match(html, /Gone/);
  // All five rows are still there.
  assert.equal(html.split("fantasy-board-row__rank").length - 1, 5);
});

test("a note renders on its own line under the player and in the pool-facing markup", () => {
  const board = setBoardNote(emptyBoard(), 2, "Penalties and set pieces");
  const html = renderBoardRows(board, ranked(), {});
  assert.match(html, /fantasy-board-row__note">Penalties and set pieces</);
});

test("opening a note swaps the row's note line for an input bound to that player", () => {
  const html = renderBoardRows(emptyBoard(), ranked(), { noteEditId: 3 });
  assert.match(html, /data-board-note-input="3"/);
  assert.match(html, /data-board-note-save="3"/);
  assert.match(html, /data-board-note-cancel/);
});

test("only the true top and bottom of the board have their move buttons disabled", () => {
  const html = renderBoardRows(emptyBoard(), ranked(), {});
  assert.match(html, /data-board-move-up="1" disabled/);
  assert.match(html, /data-board-move-down="5" disabled/);
  assert.doesNotMatch(html, /data-board-move-up="3" disabled/);
});

test("the compact card windows onto the live part of the board, the full panel does not", () => {
  // 20 players so the compact window (14) genuinely bites.
  const players = Array.from({ length: 20 }, (_, index) => ({
    id: index + 1,
    name: `Player ${index + 1}`,
    team: "Arsenal",
    position: "MID",
    xp: 100 - index,
  }));
  const rankedPlayers = rankedPoolFor(players, 4);
  const drafted = new Set([1, 2, 3, 4, 5]);

  const compact = renderFantasyBoardPanel(emptyBoard(), rankedPlayers, { draftedIds: drafted, compact: true });
  // The window starts at the first player still available, so the five gone
  // above it are out of view and the tail is in.
  assert.doesNotMatch(compact, />Player 1</);
  assert.match(compact, />Player 6</);
  assert.match(compact, />Player 19</);
  assert.match(compact, /The My board tab has all 20/);

  const full = renderFantasyBoardPanel(emptyBoard(), rankedPlayers, { draftedIds: drafted });
  assert.match(full, />Player 1</);
  assert.doesNotMatch(full, /The My board tab has all 20/);
});

test("the compact card keeps import and reset, and drops only the filter row", () => {
  const board = moveBoardPlayerToTop(emptyBoard(), ranked(), 5);
  const compact = renderFantasyBoardPanel(board, ranked(), { compact: true });
  assert.match(compact, /data-board-import-toggle/);
  assert.match(compact, /data-board-reset/);
  assert.doesNotMatch(compact, /data-board-search/);
  assert.match(renderFantasyBoardPanel(board, ranked(), {}), /data-board-search/);
});

test("the head chip names the tier the next pick comes from and how many are left", () => {
  const board = toggleTierBreak(emptyBoard(), ranked(), 3);
  assert.match(renderFantasyBoardPanel(board, ranked(), { draftedIds: new Set() }), /Tier 1 · 2 left/);
  assert.match(renderFantasyBoardPanel(board, ranked(), { draftedIds: new Set([1, 2]) }), /Tier 2 · 3 left/);
});

test("the filter narrows the visible rows without changing what a tier count means", () => {
  const board = toggleTierBreak(emptyBoard(), ranked(), 3);
  const html = renderBoardRows(board, ranked(), { filter: { position: "MID", search: "" } });
  assert.match(html, /Mohamed Salah/);
  assert.doesNotMatch(html, /Erling Haaland/);
  // Tier 1 still reports both of its players, not just the midfielder shown.
  assert.match(html, /2 of 2 left/);
});

test("an empty pool explains itself instead of rendering an empty list", () => {
  assert.match(renderFantasyBoardPanel(emptyBoard(), []), /nothing to rank/);
});

test("the import report names every dropped line and its reason, and says so when none dropped", () => {
  const dirty = renderFantasyBoardPanel(emptyBoard(), ranked(), {
    importOpen: true,
    importResult: {
      order: [1, 2],
      tierBreakIds: [2],
      unmatched: [{ name: "Zlatan Ibrahimovic", reason: "no match" }],
      duplicates: [{ name: "Mo Salah" }],
    },
  });
  assert.match(dirty, /Matched 2 players and 1 tier break/);
  assert.match(dirty, /1 line did not match/);
  assert.match(dirty, /Zlatan Ibrahimovic/);
  assert.match(dirty, /no match/);
  assert.match(dirty, /Listed more than once[^<]*Mo Salah/);

  const clean = renderFantasyBoardPanel(emptyBoard(), ranked(), {
    importOpen: true,
    importResult: { order: [1], tierBreakIds: [], unmatched: [], duplicates: [] },
  });
  assert.match(clean, /Nothing was dropped/);
});

test("a pasted name is escaped in the unmatched report rather than reaching the page as markup", () => {
  const html = renderFantasyBoardPanel(emptyBoard(), ranked(), {
    importOpen: true,
    importResult: {
      order: [],
      tierBreakIds: [],
      unmatched: [{ name: "<img src=x onerror=alert(1)>", reason: "no match" }],
      duplicates: [],
    },
  });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test("a note is escaped in both its row line and its title attribute", () => {
  const board = setBoardNote(emptyBoard(), 1, 'he "rotates" & rests');
  const html = renderBoardRows(board, ranked(), { noteEditId: 1 });
  assert.match(html, /value="he &quot;rotates&quot; &amp; rests"/);
});
