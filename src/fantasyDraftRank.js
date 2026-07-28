// Draft board: one cross-position ranking answering "who should I take next".
//
// Ranking by raw xP is the obvious approach and it is wrong. It would tell you
// to spend an early pick on an elite goalkeeper, because keepers rack up
// appearance and clean-sheet points steadily. But every manager in the league
// will end up with a keeper, and the gap between the best keeper and the
// twenty-first best is small. The gap between the best forward and the
// thirtieth is not. What a pick actually buys you is the margin over the player
// you could have had for free later, so this module ranks by that margin:
// value over replacement.
//
// Replacement level is a property of the LEAGUE, not of the player pool, which
// is why this is computed in the client against the league's own size rather
// than baked into players.json. A keeper is worth far more in a 12-manager
// league than a 4-manager one, because in the small league good keepers are
// still lying around in the last round.
//
// Pure: array in, array out. No DOM, no fetch. Same contract as the rest of
// src/fantasy*.js.

import { SQUAD_SLOTS } from "./fantasy.js";

// The xP of the best player at each position who will still be undrafted once
// every manager has filled that position's slots: the (leagueSize * slots)-th
// best, zero-indexed, which is the first player past the ones that get taken.
//
// When the pool is thinner than the league would consume, replacement falls to
// the worst available rather than to zero. Pretending a replacement is worth 0
// there would inflate everyone's margin at that position and hand it the whole
// top of the board, which is exactly backwards: a position so thin that it runs
// out is one where the last few picks are near worthless, not priceless.
export function replacementLevels(players, leagueSize, squadSlots = SQUAD_SLOTS) {
  const levels = {};
  const size = Math.max(1, Math.floor(Number(leagueSize) || 1));

  for (const position of Object.keys(squadSlots)) {
    const ranked = (players ?? [])
      .filter((player) => player?.position === position && player.xp != null)
      .map((player) => Number(player.xp))
      .sort((a, b) => b - a);

    if (!ranked.length) {
      levels[position] = 0;
      continue;
    }
    const consumed = size * (squadSlots[position] ?? 0);
    levels[position] = consumed < ranked.length ? ranked[consumed] : ranked[ranked.length - 1];
  }
  return levels;
}

// A player's margin over what the same position will still offer for free
// later. Can be negative, and legitimately so: a fourth-choice keeper is worth
// less than the keeper you could pick up in the final round, and the board
// should say that out loud rather than clamping it to zero.
export function valueOverReplacement(player, replacementLevels_) {
  if (!player || player.xp == null) return null;
  const replacement = replacementLevels_?.[player.position] ?? 0;
  return Number(player.xp) - replacement;
}

// Which round a given overall rank is likely to go in, for the board's "R3"
// style hint. One-indexed, and only a guide: it assumes managers draft roughly
// in board order, which they never quite do.
export function projectedRound(rank, leagueSize) {
  const size = Math.max(1, Math.floor(Number(leagueSize) || 1));
  if (!Number.isFinite(rank) || rank < 1) return null;
  return Math.ceil(rank / size);
}

// The board itself: every player with a `vor`, a 1-indexed `draftRank` and a
// `projectedRound`, ordered best first.
//
// Players with no xP at all cannot be ranked against anyone, so they sort to
// the bottom with a null rank rather than being dropped (they are still
// draftable, and a manager who knows something the data does not should still
// be able to find them) and rather than being given a fabricated rank.
// Ties break by xP then by name, so the order is stable across renders instead
// of shuffling every time the pool is re-sorted.
export function rankDraftPool(players, leagueSize, squadSlots = SQUAD_SLOTS) {
  const levels = replacementLevels(players, leagueSize, squadSlots);

  const ranked = [];
  const unranked = [];
  for (const player of players ?? []) {
    if (!player) continue;
    const vor = valueOverReplacement(player, levels);
    if (vor == null) unranked.push({ ...player, vor: null, draftRank: null, projectedRound: null });
    else ranked.push({ ...player, vor });
  }

  ranked.sort((a, b) => b.vor - a.vor || Number(b.xp) - Number(a.xp) || String(a.name).localeCompare(String(b.name)));
  ranked.forEach((player, index) => {
    player.draftRank = index + 1;
    player.projectedRound = projectedRound(index + 1, leagueSize);
  });
  unranked.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  return [...ranked, ...unranked];
}

// Sort comparators the pool's sort control offers. Kept here rather than in the
// view so the ordering rules are testable, and so the demo and the real draft
// room cannot drift apart on what "by rank" means.
//
// Every comparator puts a missing value last regardless of direction: a player
// with no xP should never lead the board just because null sorted low.
// `board` reads a boardRank the caller stamped on first (see
// withBoardAnnotations in src/fantasyDraftBoard.js), rather than importing the
// board here: replacement level and a manager's own opinion are different
// things, and this module only knows about the first one. With no board
// annotation present every player's boardRank is missing, so byNumber sorts
// them all last and the order collapses to the name tie-break - which is why
// callers must annotate before offering this sort.
export const POOL_SORTS = {
  rank: { label: "Rank", compare: byNumber((player) => player.draftRank, "asc") },
  board: { label: "Board", compare: byNumber((player) => player.boardRank, "asc") },
  xp: { label: "xP", compare: byNumber((player) => player.xp, "desc") },
  name: { label: "Name", compare: (a, b) => String(a?.name ?? "").localeCompare(String(b?.name ?? "")) },
};

export const DEFAULT_POOL_SORT = "rank";

export function sortPoolBy(players, sortKey) {
  const sort = POOL_SORTS[sortKey] ?? POOL_SORTS[DEFAULT_POOL_SORT];
  return [...(players ?? [])].sort(sort.compare);
}

function byNumber(pick, direction) {
  return (a, b) => {
    const left = pick(a);
    const right = pick(b);
    const leftMissing = left == null || !Number.isFinite(Number(left));
    const rightMissing = right == null || !Number.isFinite(Number(right));
    if (leftMissing && rightMissing) return String(a?.name ?? "").localeCompare(String(b?.name ?? ""));
    if (leftMissing) return 1;
    if (rightMissing) return -1;
    return direction === "asc" ? Number(left) - Number(right) : Number(right) - Number(left);
  };
}
