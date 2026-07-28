// The personal draft board: a manager's own ranking of the player pool, with
// tiers and per-player notes, carried intact through a live draft.
//
// This is the gap in the market leader. Sleeper has no rankings import, no
// editor, no tiers and no notes; its queue takes players one tap at a time,
// holds no tiers or notes, and loses players as other drafters select them,
// which makes it a consumable rather than a plan. A whole paid tooling market
// exists to fill that, and FantasyPros has run over two million mock drafts on
// the tooling that does. It is also where this app's own value-over-
// replacement work becomes visible at the moment a manager is paying the most
// attention.
//
// Pure: array/object in, value out. No DOM, no fetch, no localStorage (app.js
// owns persistence), same contract as the rest of src/fantasy*.js.
//
// -- Relationship to the pick queue -------------------------------------------
// The BOARD and the QUEUE are different objects and deliberately stay so. The
// queue (src/fantasyDraft.js, persisted per league in fantasy_draft_queue) is
// a short shortlist the server autopicks from when a clock expires: it is
// authoritative, it costs a round trip, and it is short. The board is the
// whole pool in a manager's own order, and it is advisory. Folding the board
// into the queue would either make the server autopick from 500 entries or
// force the board to be as short as a queue; neither is the feature.
//
// -- The default board is not a second definition of player value -------------
// A board that has never been touched IS src/fantasyDraftRank.js's value-over-
// replacement order, unmodified. `order` starts empty and is materialised from
// that ranking the first time a manager actually changes something, so an
// untouched board can never drift from the app's own ranking as the pool or
// the league size changes, and there is exactly one definition of what a
// player is worth.
//
// -- A tier is a contiguous band, and it belongs to the player who starts it --
// `tierBreaks` holds the ids of the players who BEGIN a new tier; the top of
// the board always begins tier 1 implicitly. Storing breaks rather than a
// per-player tier number is what makes "three left in this tier" a true
// statement: tiers cannot overlap or interleave, because they are cuts through
// one ordered list. The consequence to know about is that moving a player who
// starts a tier moves the cut with him, which is the behaviour a manager
// dragging a tier's first name up expects, and the reason the up/down controls
// never need to reason about tiers at all.
//
// -- Survival ------------------------------------------------------------------
// Nothing here ever removes a player. A drafted player stays exactly where the
// manager put him, marked taken; the plan a manager spent an evening building
// has to still read as that plan in round nine, and a board that deletes rows
// out from under them as rivals pick is the failure mode this feature exists
// to avoid. A player who disappears from the POOL (a fresh squad bake dropped
// him) is skipped rather than rendered as a hole, and a player the pool has
// gained that the board has never seen lands at the bottom rather than being
// silently unrankable.

import { rankDraftPool } from "./fantasyDraftRank.js";

export const MAX_NOTE_LENGTH = 160;

// A paste is user input from a spreadsheet or a rival site, so it gets a hard
// ceiling: the pool itself is a few hundred players, and anything past this is
// either a mistake or an attempt to make the matcher run for a long time.
export const MAX_IMPORT_LINES = 1200;

export function emptyBoard() {
  return { order: [], tierBreaks: [], notes: {} };
}

// Normalises whatever came out of localStorage (or a future server payload)
// into the board shape, dropping anything of the wrong type rather than
// letting a corrupt value reach a renderer.
export function normalizeBoard(raw) {
  const board = emptyBoard();
  if (!raw || typeof raw !== "object") return board;
  if (Array.isArray(raw.order)) board.order = raw.order.filter((id) => id != null);
  if (Array.isArray(raw.tierBreaks)) board.tierBreaks = raw.tierBreaks.filter((id) => id != null);
  if (raw.notes && typeof raw.notes === "object") {
    for (const [playerId, note] of Object.entries(raw.notes)) {
      const clean = cleanNote(note);
      if (clean) board.notes[playerId] = clean;
    }
  }
  return board;
}

// Whether the manager has actually done anything, which is what decides
// whether the UI may call this "your board" rather than the app's ranking.
export function isCustomBoard(board) {
  return Boolean(
    (board?.order?.length ?? 0) ||
      (board?.tierBreaks?.length ?? 0) ||
      Object.keys(board?.notes ?? {}).length,
  );
}

export function cleanNote(value) {
  return String(value ?? "")
    // Control characters and angle brackets go the way cleanChatText
    // (src/fantasyChat.js) drops them: a note is one line of prose, and a
    // newline in it is only ever a layout attack. Renderers escape on top.
    .replace(/[\u0000-\u001f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NOTE_LENGTH);
}

// The pool in this manager's order: their own ordering first (skipping ids the
// pool no longer has), then anything the pool has gained, in the app's own
// value-over-replacement order. An untouched board therefore returns exactly
// `rankedPlayers`' order.
export function effectiveOrder(board, rankedPlayers) {
  const pool = rankedPlayers ?? [];
  const known = new Set(pool.map((player) => player.id));
  const seen = new Set();
  const order = [];
  for (const playerId of board?.order ?? []) {
    if (!known.has(playerId) || seen.has(playerId)) continue;
    seen.add(playerId);
    order.push(playerId);
  }
  for (const player of pool) {
    if (seen.has(player.id)) continue;
    seen.add(player.id);
    order.push(player.id);
  }
  return order;
}

// One row per board entry, in board order: the player, their board rank, which
// tier they are in, whether they begin it, their note, and whether somebody
// has already drafted them.
export function boardRows(board, rankedPlayers, draftedIds) {
  const byId = new Map((rankedPlayers ?? []).map((player) => [player.id, player]));
  const breaks = new Set(board?.tierBreaks ?? []);
  const notes = board?.notes ?? {};
  const drafted = draftedIds ?? new Set();

  const rows = [];
  let tier = 1;
  for (const playerId of effectiveOrder(board, rankedPlayers)) {
    const player = byId.get(playerId);
    if (!player) continue;
    const startsTier = rows.length > 0 && breaks.has(playerId);
    if (startsTier) tier += 1;
    rows.push({
      playerId,
      player,
      rank: rows.length + 1,
      tier,
      startsTier: rows.length === 0 || startsTier,
      note: notes[playerId] ?? notes[String(playerId)] ?? "",
      taken: Boolean(drafted.has?.(playerId)),
    });
  }
  return rows;
}

// Per-tier totals and how many of each are still on the board undrafted. This
// is the actual decision aid at the moment of a pick: "three left in this
// tier" is what tells a manager whether to reach now or wait a round.
export function tierSummaries(rows) {
  const summaries = new Map();
  for (const row of rows ?? []) {
    const entry = summaries.get(row.tier) ?? { tier: row.tier, total: 0, remaining: 0 };
    entry.total += 1;
    if (!row.taken) entry.remaining += 1;
    summaries.set(row.tier, entry);
  }
  return [...summaries.values()];
}

// The tier the next pick would come from (the highest-ranked tier that still
// has anyone left) and how many of it survive. Null once the whole board is
// drafted.
export function activeTier(rows) {
  const next = (rows ?? []).find((row) => !row.taken);
  if (!next) return null;
  return tierSummaries(rows).find((summary) => summary.tier === next.tier) ?? null;
}

// -- Mutations ------------------------------------------------------------------
//
// Every one of these materialises `order` from the effective order first, so a
// board that was still the app's own ranking becomes an explicit list at the
// moment it stops being it, and never before. All return a NEW board, or the
// SAME reference when nothing changed, so a caller can assign the result back
// unconditionally without churning renders.

function withOrder(board, order) {
  return { order, tierBreaks: [...(board?.tierBreaks ?? [])], notes: { ...(board?.notes ?? {}) } };
}

export function moveBoardPlayer(board, rankedPlayers, playerId, direction) {
  const order = effectiveOrder(board, rankedPlayers);
  const index = order.indexOf(playerId);
  if (index === -1) return board;
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= order.length) return board;
  const next = [...order];
  [next[index], next[swapWith]] = [next[swapWith], next[index]];
  return withOrder(board, next);
}

// The one move a manager actually wants often: "I do not care about the
// ordering argument, I am taking him first". Nudging one slot at a time from
// rank 180 to rank 1 is not a feature.
export function moveBoardPlayerToTop(board, rankedPlayers, playerId) {
  const order = effectiveOrder(board, rankedPlayers);
  const index = order.indexOf(playerId);
  if (index <= 0) return board;
  const next = [playerId, ...order.filter((id) => id !== playerId)];
  return withOrder(board, next);
}

// Starts (or stops) a tier at this player. The top of the board always begins
// tier 1, so toggling a break there is a no-op rather than an off-by-one that
// would produce an empty tier.
export function toggleTierBreak(board, rankedPlayers, playerId) {
  const order = effectiveOrder(board, rankedPlayers);
  const index = order.indexOf(playerId);
  if (index <= 0) return board;
  const breaks = new Set(board?.tierBreaks ?? []);
  if (breaks.has(playerId)) breaks.delete(playerId);
  else breaks.add(playerId);
  return { order, tierBreaks: [...breaks], notes: { ...(board?.notes ?? {}) } };
}

export function setBoardNote(board, playerId, text) {
  const clean = cleanNote(text);
  const notes = { ...(board?.notes ?? {}) };
  const key = String(playerId);
  delete notes[key];
  delete notes[playerId];
  if (clean) notes[key] = clean;
  return { order: [...(board?.order ?? [])], tierBreaks: [...(board?.tierBreaks ?? [])], notes };
}

export function resetBoard() {
  return emptyBoard();
}

// -- Import ----------------------------------------------------------------------
//
// Pasting a ranking in is the whole reason a manager who already has a board
// somewhere else would use ours, and a paste that silently drops what it could
// not understand is worse than one that refuses: a board truncated by eleven
// unmatched names still looks complete, and the manager finds out in round
// four. So the matcher's contract is that every input line ends up in exactly
// one of `order`, `duplicates` or `unmatched`, and `unmatched` carries a
// reason.

const RANK_PREFIX = /^\s*\d{1,4}\s*[.):\-\]]?\s+|^\s*\d{1,4}[.)]\s*/;
const TRAILING_PARENS = /\s*\([^)]*\)\s*$/;
const TIER_LINE = /^[\s\-=_*#]*tier\b[\s\-=_*#:]*[a-z0-9]*[\s\-=_*#:]*$/i;
const SEPARATOR_LINE = /^[\s\-=_*]{3,}$/;

// One entry per meaningful line: either a tier marker or a player name.
//
// Accepted shapes, because a paste comes from wherever the manager already
// keeps their rankings: a bare name per line; a numbered list ("1. Salah",
// "12) Salah", "3 Salah"); a spreadsheet row where the columns are tabs or
// commas (the first non-numeric column is the name, the rest are club/position
// noise); a trailing parenthetical ("Salah (LIV - MID)"). Tier markers are any
// line that is only the word "tier" plus a label, or a rule of dashes, since
// both are how people actually write a tier break down.
export function parseRankingImport(text) {
  const lines = String(text ?? "").split(/\r?\n/).slice(0, MAX_IMPORT_LINES);
  const entries = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (TIER_LINE.test(trimmed) || SEPARATOR_LINE.test(trimmed)) {
      entries.push({ kind: "tier" });
      continue;
    }
    const name = playerNameFromLine(trimmed);
    if (name) entries.push({ kind: "player", name });
  }
  return entries;
}

function playerNameFromLine(line) {
  const fields = line.includes("\t") ? line.split("\t") : line.includes(",") ? line.split(",") : [line];
  for (const raw of fields) {
    const field = raw.replace(/^["']|["']$/g, "").replace(RANK_PREFIX, "").replace(TRAILING_PARENS, "").trim();
    if (!field) continue;
    // A bare number is a rank or a stat column, never a name.
    if (/^[\d.\-+%]+$/.test(field)) continue;
    return field;
  }
  return "";
}

// Accents, punctuation and case all vary between whoever typed the paste and
// whoever typed the squad list, and none of them carry meaning for a name
// match, so they are all flattened before anything is compared.
export function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function buildNameIndex(players) {
  const full = new Map();
  const last = new Map();
  const first = new Map();
  const entries = [];
  for (const player of players ?? []) {
    if (!player || player.id == null) continue;
    const normalized = normalizeName(player.name);
    if (!normalized) continue;
    const tokens = normalized.split(" ");
    const entry = { player, normalized, tokens, surname: tokens[tokens.length - 1] };
    entries.push(entry);
    push(full, normalized, entry);
    push(last, entry.surname, entry);
    // Football is full of players everyone calls by their first name
    // ("Alisson", "Rodri", "Gabriel"), and the squad bake stores them under
    // a full name ("Alisson Becker") while abbreviating everyone else
    // ("C. Palmer"). A single-token paste therefore has to be checkable as a
    // first name as well as a surname. Initials are skipped: bucketing 300
    // players under "c" would only ever produce an ambiguity.
    if (tokens.length > 1 && tokens[0].length > 1) push(first, tokens[0], entry);
  }
  return { full, last, first, entries };
}

function push(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// Bounded Levenshtein: bails out as soon as the best possible remaining
// distance exceeds `limit`, so a 1200-line paste against a 600-player pool
// stays a fraction of a second rather than a full quadratic sweep.
export function boundedEditDistance(a, b, limit) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowBest = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
      if (current[j] < rowBest) rowBest = current[j];
    }
    if (rowBest > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}

function fuzzyThreshold(length) {
  if (length <= 4) return 0;
  if (length <= 7) return 1;
  return 2;
}

function uniqueOrAmbiguous(candidates) {
  if (!candidates?.length) return null;
  if (candidates.length === 1) return { player: candidates[0].player };
  return { reason: "ambiguous" };
}

// Every entry tied at the smallest acceptable distance. Returned as a list
// rather than a verdict so the caller can still break a tie on the given name
// before giving up: "Cole Palmar" is one letter from BOTH "C. Palmer" and
// "A. Palmer", and only the first name says which.
function bestFuzzy(target, entries, pick) {
  const limit = fuzzyThreshold(target.length);
  if (limit === 0) return [];
  let best = limit + 1;
  let winners = [];
  for (const entry of entries) {
    const distance = boundedEditDistance(target, pick(entry), limit);
    if (distance > limit) continue;
    if (distance < best) {
      best = distance;
      winners = [entry];
    } else if (distance === best) {
      winners.push(entry);
    }
  }
  return winners;
}

// Narrows several same-surname candidates by the pasted given name. A
// candidate qualifies when the pasted fragment and its own given name are a
// prefix of one another in either direction, which covers both "M. Salah"
// against a pool that spells the name out and "Mohamed Salah" against a pool
// that abbreviates it. Falls back to the full list rather than to nothing,
// so a given name that matches nobody leaves the caller reporting an
// ambiguity instead of a false "no match".
function narrowByGivenName(candidates, tokens) {
  if (candidates.length <= 1 || tokens.length < 2) return candidates;
  const given = tokens.slice(0, -1).join(" ");
  if (!given) return candidates;
  const narrowed = candidates.filter((entry) => {
    const entryGiven = entry.tokens.slice(0, -1).join(" ");
    if (!entryGiven) return false;
    return entryGiven.startsWith(given) || given.startsWith(entryGiven);
  });
  return narrowed.length ? narrowed : candidates;
}

// Resolves one pasted name to a pool player, or explains why it could not.
// The ladder runs strongest signal first and stops at the first rung that
// produces a UNIQUE answer; a rung that produces several is reported as
// ambiguous rather than silently picking one, because guessing between two
// real players is exactly the silent corruption this whole function exists to
// avoid.
export function matchPlayerName(rawName, index) {
  const normalized = normalizeName(rawName);
  if (!normalized) return { reason: "empty" };
  const tokens = normalized.split(" ");
  const surname = tokens[tokens.length - 1];

  // Each rung is a candidate list; the first that narrows to exactly one wins.
  // Anything that narrowed to several is remembered so the failure can be
  // reported as "ambiguous" (we found him twice) rather than "no match" (we
  // never found him), which are different things to tell a manager.
  const rungs = [
    () => index.full.get(normalized) ?? [],
    () => (tokens.length === 1 ? (index.last.get(surname) ?? []) : []),
    () => (tokens.length === 1 ? (index.first.get(normalized) ?? []) : []),
    () => (tokens.length > 1 ? narrowByGivenName(index.last.get(surname) ?? [], tokens) : []),
    () => narrowByGivenName(bestFuzzy(normalized, index.entries, (entry) => entry.normalized), tokens),
    () => narrowByGivenName(bestFuzzy(surname, index.entries, (entry) => entry.surname), tokens),
  ];

  let sawAmbiguity = false;
  for (const rung of rungs) {
    const verdict = uniqueOrAmbiguous(rung());
    if (verdict?.player) return verdict;
    if (verdict?.reason === "ambiguous") sawAmbiguity = true;
  }
  return { reason: sawAmbiguity ? "ambiguous" : "no match" };
}

// The whole paste, resolved. `order` is the matched players in the order they
// were pasted, `tierBreakIds` the players a tier marker immediately preceded,
// and every line that produced neither is accounted for in `duplicates` or
// `unmatched` so the UI can show it rather than pretend the import was clean.
export function resolveRankingImport(text, players) {
  const index = buildNameIndex(players);
  const order = [];
  const placed = new Set();
  const tierBreakIds = [];
  const unmatched = [];
  const duplicates = [];
  let pendingTierBreak = false;

  for (const entry of parseRankingImport(text)) {
    if (entry.kind === "tier") {
      pendingTierBreak = true;
      continue;
    }
    const match = matchPlayerName(entry.name, index);
    if (!match.player) {
      unmatched.push({ name: entry.name, reason: match.reason });
      continue;
    }
    if (placed.has(match.player.id)) {
      duplicates.push({ name: entry.name, player: match.player });
      continue;
    }
    placed.add(match.player.id);
    order.push(match.player.id);
    // A marker before the very first name is just a header for tier 1, which
    // the top of the board already begins.
    if (pendingTierBreak && order.length > 1) tierBreakIds.push(match.player.id);
    pendingTierBreak = false;
  }

  return { order, tierBreakIds, unmatched, duplicates };
}

// An import REPLACES the ordering and the tier cuts (both came from the paste,
// and old cuts would land at meaningless positions in a re-ordered list) and
// KEEPS the notes, which are attached to players and are still true. Players
// the paste never mentioned keep their relative order, below everything it
// did, so a partial ranking of the top 60 is a usable board rather than a
// 60-player one.
export function applyRankingImport(board, rankedPlayers, resolved) {
  const imported = resolved?.order ?? [];
  const importedSet = new Set(imported);
  const rest = effectiveOrder(board, rankedPlayers).filter((playerId) => !importedSet.has(playerId));
  return {
    order: [...imported, ...rest],
    tierBreaks: [...(resolved?.tierBreakIds ?? [])],
    notes: { ...(board?.notes ?? {}) },
  };
}

// -- Pool integration ------------------------------------------------------------

// The app's value-over-replacement ranking, which is both the pool's own order
// and the board's default. Wrapped here only so every board caller asks for it
// the same way, with the league size that replacement level depends on.
export function rankedPoolFor(players, leagueSize) {
  return rankDraftPool(players ?? [], leagueSize ?? 1);
}

// Player-keyed board facts for the pool table: rank, tier and note, so a pool
// row can show a manager where their own board puts a player without the pool
// having to know how a board is stored.
export function boardIndex(board, rankedPlayers, draftedIds) {
  const index = new Map();
  for (const row of boardRows(board, rankedPlayers, draftedIds)) {
    index.set(row.playerId, { boardRank: row.rank, boardTier: row.tier, boardNote: row.note });
  }
  return index;
}

// Stamps boardRank/boardTier/boardNote onto a ranked pool so the pool's own
// sort control can order by the manager's board (see POOL_SORTS in
// src/fantasyDraftRank.js) and its rows can show a tier chip and a note
// marker. Returns a NEW array; never mutates `rankedPlayers`.
export function withBoardAnnotations(rankedPlayers, board, draftedIds) {
  const index = boardIndex(board, rankedPlayers, draftedIds);
  return (rankedPlayers ?? []).map((player) => ({ ...player, ...(index.get(player.id) ?? {}) }));
}
