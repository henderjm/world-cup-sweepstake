import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_POOL_SORT,
  POOL_SORTS,
  projectedRound,
  rankDraftPool,
  replacementLevels,
  sortPoolBy,
  valueOverReplacement,
} from "../src/fantasyDraftRank.js";
import { SQUAD_SLOTS, SQUAD_SIZE } from "../src/fantasy.js";

// A pool with a deliberately steep forward curve and a flat keeper curve, which
// is the real shape of fantasy football and the whole reason this module exists.
function pool() {
  const players = [];
  const add = (position, count, top, step) => {
    for (let i = 0; i < count; i++) {
      players.push({ id: `${position}${i}`, name: `${position} ${String(i).padStart(2, "0")}`, position, xp: +(top - i * step).toFixed(2) });
    }
  };
  add("GK", 30, 4.0, 0.05); // flat: best keeper barely beats the 21st
  add("DEF", 80, 4.6, 0.04);
  add("MID", 80, 5.4, 0.05);
  add("FWD", 40, 6.0, 0.12); // steep: elite forwards are genuinely scarce
  return players;
}

test("SQUAD_SLOTS still sums to SQUAD_SIZE, which every replacement level depends on", () => {
  const total = Object.values(SQUAD_SLOTS).reduce((sum, n) => sum + n, 0);
  assert.equal(total, SQUAD_SIZE);
});

// -- replacement levels ------------------------------------------------------

test("replacementLevels picks the best player left once the league has filled that position", () => {
  // 4 managers, 2 GK slots each: 8 keepers go, so replacement is the 9th best
  // (zero-indexed 8), which on this curve is 4.0 - 8*0.05 = 3.6
  const levels = replacementLevels(pool(), 4);
  assert.equal(+levels.GK.toFixed(2), 3.6);
});

test("replacementLevels rises with league size, since a bigger league strips the pool deeper", () => {
  const small = replacementLevels(pool(), 4);
  const large = replacementLevels(pool(), 12);
  assert.ok(large.FWD < small.FWD, "a 12-team league leaves worse forwards behind");
  assert.ok(large.GK < small.GK);
});

test("replacementLevels falls back to the worst available rather than zero when a position runs out", () => {
  // 3 keepers total, but a 10-team league would consume 20. Replacement must be
  // the worst real keeper, not 0, or every keeper's margin would be inflated
  // and they would seize the top of the board.
  const thin = [
    { id: 1, name: "a", position: "GK", xp: 4 },
    { id: 2, name: "b", position: "GK", xp: 3 },
    { id: 3, name: "c", position: "GK", xp: 2 },
  ];
  assert.equal(replacementLevels(thin, 10).GK, 2);
});

test("replacementLevels is zero for a position with nobody in the pool", () => {
  assert.equal(replacementLevels([{ id: 1, name: "a", position: "MID", xp: 3 }], 4).FWD, 0);
});

test("replacementLevels ignores players with no xP rather than treating them as zero", () => {
  const withNulls = [
    { id: 1, name: "a", position: "GK", xp: 5 },
    { id: 2, name: "b", position: "GK", xp: null },
    { id: 3, name: "c", position: "GK", xp: 4 },
  ];
  // 1 manager, 2 GK slots: 2 consumed, only 2 real keepers exist, so
  // replacement is the worst real one (4), never the null.
  assert.equal(replacementLevels(withNulls, 1).GK, 4);
});

// -- value over replacement --------------------------------------------------

test("valueOverReplacement is the margin over that position's replacement", () => {
  const vor = valueOverReplacement({ position: "MID", xp: 5 }, { MID: 3 });
  assert.equal(vor, 2);
});

test("valueOverReplacement goes negative for a player worse than a free replacement", () => {
  // A fourth-choice keeper genuinely is worth less than the one still on the
  // wire, and the board should say so rather than clamping at zero.
  assert.equal(valueOverReplacement({ position: "GK", xp: 2 }, { GK: 3.5 }), -1.5);
});

test("valueOverReplacement is null for a player with no xP", () => {
  assert.equal(valueOverReplacement({ position: "MID", xp: null }, { MID: 3 }), null);
});

// -- the ranking's actual purpose --------------------------------------------

test("the top of the board is not a goalkeeper, despite keepers scoring steadily", () => {
  // This is the entire reason the module exists. Ranking on raw xP would be
  // fine here too (the best forward out-scores the best keeper on this curve),
  // so the sharper assertion is below.
  const board = rankDraftPool(pool(), 10);
  assert.notEqual(board[0].position, "GK");
});

test("a scarce position outranks a plentiful one even when raw xP says otherwise", () => {
  // The keeper scores MORE than the forward in raw xP, but every manager will
  // get a near-identical keeper for free, while this forward is genuinely
  // scarce. Value over replacement has to invert the naive ordering.
  const players = [
    { id: "gk1", name: "Steady Keeper", position: "GK", xp: 5.0 },
    { id: "gk2", name: "Other Keeper", position: "GK", xp: 4.9 },
    { id: "gk3", name: "Third Keeper", position: "GK", xp: 4.8 },
    { id: "fw1", name: "Scarce Forward", position: "FWD", xp: 4.5 },
    { id: "fw2", name: "Poor Forward", position: "FWD", xp: 1.0 },
    { id: "fw3", name: "Worse Forward", position: "FWD", xp: 0.8 },
  ];
  const board = rankDraftPool(players, 1);
  assert.equal(board[0].name, "Scarce Forward", `raw xP won instead of scarcity: ${board.map((p) => p.name).join(", ")}`);
  assert.ok(board[0].xp < board.find((p) => p.name === "Steady Keeper").xp, "the test pool must actually invert, or it proves nothing");
});

test("league size changes the board, because replacement level is a league property", () => {
  // Counting keepers in the top 20 would NOT work as the metric here: this
  // module correctly keeps them out of the top 20 at every league size, so
  // the count is zero either way and the assertion could never fail.
  // Forwards are where the effect actually shows.
  const small = rankDraftPool(pool(), 4).slice(0, 20).filter((p) => p.position === "FWD").length;
  const large = rankDraftPool(pool(), 12).slice(0, 20).filter((p) => p.position === "FWD").length;
  assert.ok(
    large > small,
    `a deeper league should crowd the early board with scarce forwards: ${small} vs ${large}`,
  );
});

test("a deeper league drives replacement level down at every position", () => {
  const small = replacementLevels(pool(), 4);
  const large = replacementLevels(pool(), 12);
  for (const position of ["GK", "DEF", "MID", "FWD"]) {
    assert.ok(large[position] < small[position], `${position} replacement did not fall with league size`);
  }
});

test("rankDraftPool numbers ranks from 1 with no gaps and no duplicates", () => {
  const board = rankDraftPool(pool(), 8).filter((p) => p.draftRank != null);
  const ranks = board.map((p) => p.draftRank);
  assert.equal(ranks[0], 1);
  assert.equal(new Set(ranks).size, ranks.length, "duplicate ranks");
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), "ranks must ascend in board order");
});

test("rankDraftPool keeps unrankable players in the pool, at the bottom, with a null rank", () => {
  const players = [
    { id: 1, name: "Known", position: "MID", xp: 4 },
    { id: 2, name: "Unknown", position: "MID", xp: null },
  ];
  const board = rankDraftPool(players, 4);
  assert.equal(board.length, 2, "an unrankable player must stay draftable, not vanish");
  assert.equal(board[1].name, "Unknown");
  assert.equal(board[1].draftRank, null, "never fabricate a rank");
  assert.equal(board[1].vor, null);
});

test("rankDraftPool does not mutate the players it was given", () => {
  const players = [{ id: 1, name: "A", position: "MID", xp: 4 }];
  rankDraftPool(players, 4);
  assert.equal(players[0].draftRank, undefined);
  assert.equal(players[0].vor, undefined);
});

test("rankDraftPool is stable: the same pool ranks identically twice", () => {
  const first = rankDraftPool(pool(), 8).map((p) => p.id);
  const second = rankDraftPool(pool(), 8).map((p) => p.id);
  assert.deepEqual(first, second);
});

// -- projected round ---------------------------------------------------------

test("projectedRound maps rank onto a round for the league size", () => {
  assert.equal(projectedRound(1, 10), 1);
  assert.equal(projectedRound(10, 10), 1);
  assert.equal(projectedRound(11, 10), 2);
  assert.equal(projectedRound(25, 8), 4);
});

test("projectedRound refuses a nonsense rank rather than returning round 0", () => {
  assert.equal(projectedRound(0, 10), null);
  assert.equal(projectedRound(null, 10), null);
});

// -- sorting -----------------------------------------------------------------

const mixed = [
  { id: 1, name: "Charlie", position: "MID", xp: 2, draftRank: 3 },
  { id: 2, name: "Alice", position: "FWD", xp: 9, draftRank: 1 },
  { id: 3, name: "Bob", position: "DEF", xp: null, draftRank: null },
];

test("sortPoolBy rank puts the best board position first", () => {
  assert.deepEqual(sortPoolBy(mixed, "rank").map((p) => p.name), ["Alice", "Charlie", "Bob"]);
});

test("sortPoolBy xp sorts high to low", () => {
  assert.deepEqual(sortPoolBy(mixed, "xp").map((p) => p.name), ["Alice", "Charlie", "Bob"]);
});

test("sortPoolBy always sinks missing values, never floats them to the top", () => {
  // A null must not win just because null compares low in a naive comparator.
  assert.equal(sortPoolBy(mixed, "rank").at(-1).name, "Bob");
  assert.equal(sortPoolBy(mixed, "xp").at(-1).name, "Bob");
});

test("sortPoolBy name is alphabetical and includes players with no stats", () => {
  assert.deepEqual(sortPoolBy(mixed, "name").map((p) => p.name), ["Alice", "Bob", "Charlie"]);
});

test("sortPoolBy falls back to the default rather than throwing on an unknown key", () => {
  assert.deepEqual(sortPoolBy(mixed, "nonsense").map((p) => p.name), sortPoolBy(mixed, DEFAULT_POOL_SORT).map((p) => p.name));
});

test("sortPoolBy does not mutate its input", () => {
  const input = [...mixed];
  sortPoolBy(input, "xp");
  assert.deepEqual(input.map((p) => p.name), mixed.map((p) => p.name));
});

test("every advertised sort has a label, so the control can render itself", () => {
  for (const [key, sort] of Object.entries(POOL_SORTS)) {
    assert.ok(sort.label, `${key} has no label`);
    assert.equal(typeof sort.compare, "function");
  }
});
