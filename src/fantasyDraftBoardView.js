// HTML-string renderers for the personal draft board (src/fantasyDraftBoard.js):
// the full Board sub-tab editor and the compact card that sits in the live
// draft room's side column.
//
// Same convention as fantasyView.js / fantasyChatView.js / fantasyWaiversView.js:
// pure string in, string out, no DOM APIs, every control a unique data-*
// attribute handled by app.js's one click/input delegation (see CLAUDE.md's
// "Adding a tab or panel control").
//
// ONE renderer serves both surfaces because they are the same list with the
// same controls; `compact` only decides whether the import and filter blocks
// render and how far down the list goes. A second renderer would be a second
// place for the tier maths and the taken markers to drift.

import { abbrFor, badgeFor } from "./badges.js";
import { activeTier, boardRows, isCustomBoard, MAX_NOTE_LENGTH } from "./fantasyDraftBoard.js";

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

// How much of the board the draft-room card shows. Not the top N of the whole
// board: once forty players are gone, the top forty rows are all struck
// through and useless. The window starts at the highest-ranked player still
// available, so what a manager sees is always the live part of their plan -
// and the taken players inside that window stay visible, because "the two
// above him just went" is exactly the context a pick needs.
const COMPACT_WINDOW = 14;

function windowedRows(rows, compact) {
  if (!compact) return rows;
  const firstAvailable = rows.findIndex((row) => !row.taken);
  const start = firstAvailable === -1 ? Math.max(0, rows.length - COMPACT_WINDOW) : firstAvailable;
  return rows.slice(start, start + COMPACT_WINDOW);
}

function matchesFilter(row, filter) {
  const position = filter?.position ?? "All";
  if (position !== "All" && row.player.position !== position) return false;
  const search = (filter?.search ?? "").trim().toLowerCase();
  if (!search) return true;
  return (
    String(row.player.name).toLowerCase().includes(search) || String(row.player.team).toLowerCase().includes(search)
  );
}

// A tier heading, carrying the number that makes it a decision aid rather than
// decoration: how many of this tier are still undrafted.
function renderTierHead(summary) {
  const cliff = summary.remaining > 0 && summary.remaining <= 3;
  return `<div class="fantasy-board-tier ${cliff ? "is-cliff" : ""}">
      <span class="fantasy-board-tier__label">Tier ${summary.tier}</span>
      <span class="fantasy-board-tier__count">${summary.remaining} of ${summary.total} left</span>
    </div>`;
}

function renderNote(row, editing) {
  if (editing) {
    return `<div class="fantasy-board-note-edit">
        <input class="fantasy-input fantasy-board-note-input" type="text" maxlength="${MAX_NOTE_LENGTH}" value="${esc(row.note)}" data-board-note-input="${row.playerId}" placeholder="Why him, in one line" autocomplete="off" />
        <button class="seg" type="button" data-board-note-save="${row.playerId}">Save</button>
        <button class="seg" type="button" data-board-note-cancel>Cancel</button>
      </div>`;
  }
  if (!row.note) return "";
  return `<p class="fantasy-board-row__note">${esc(row.note)}</p>`;
}

// The compact card drops the one-slot nudges and keeps move-to-top, tier and
// note. Not an arbitrary trim: five icon buttons plus a rank, crest, position
// chip and "Gone" marker do not fit one line inside a 300px column, and a
// wrapped two-line row halves how much of the board a manager can see with
// the clock running. Nudging a player one place is prep, and the My board tab
// (which has the room) is where prep happens.
function renderRow(row, { editing, isFirst, isLast, compact }) {
  const classes = ["fantasy-board-row"];
  if (row.taken) classes.push("is-taken");
  if (row.note) classes.push("has-note");

  const nudges = compact
    ? ""
    : `<button class="fantasy-queue-btn" type="button" data-board-move-up="${row.playerId}" ${isFirst ? "disabled" : ""} aria-label="Move ${esc(row.player.name)} up the board">▲</button>
        <button class="fantasy-queue-btn" type="button" data-board-move-down="${row.playerId}" ${isLast ? "disabled" : ""} aria-label="Move ${esc(row.player.name)} down the board">▼</button>`;

  const controls = `<div class="fantasy-board-row__actions">
        ${nudges}
        <button class="fantasy-queue-btn" type="button" data-board-top="${row.playerId}" ${isFirst ? "disabled" : ""} aria-label="Move ${esc(row.player.name)} to the top of the board" title="Move to top">⇈</button>
        <button class="fantasy-queue-btn ${row.startsTier && row.rank > 1 ? "is-active" : ""}" type="button" data-board-tier-toggle="${row.playerId}" aria-pressed="${row.startsTier && row.rank > 1}" aria-label="Start a new tier at ${esc(row.player.name)}" title="Start a new tier here">⌐</button>
        <button class="fantasy-queue-btn ${row.note ? "is-active" : ""}" type="button" data-board-note-edit="${row.playerId}" aria-label="Note on ${esc(row.player.name)}" title="Note">✎</button>
      </div>`;

  return `<div class="${classes.join(" ")}">
      <div class="fantasy-board-row__main">
        <span class="fantasy-board-row__rank">${row.rank}</span>
        ${badgeFor(row.player.team)}
        <span class="fantasy-board-row__name"><strong>${esc(row.player.name)}</strong><span class="note--dim">${esc(abbrFor(row.player.team))}</span></span>
        <span class="fantasy-pos">${esc(row.player.position)}</span>
        <span class="fantasy-board-row__status">${row.taken ? "Gone" : ""}</span>
        ${controls}
      </div>
      ${renderNote(row, editing)}
    </div>`;
}

const POSITION_FILTERS = ["All", "GK", "DEF", "MID", "FWD"];

function renderFilters(filter) {
  const active = filter?.position ?? "All";
  const pills = POSITION_FILTERS.map(
    (position) =>
      `<button class="seg ${position === active ? "is-active" : ""}" type="button" data-board-position-filter="${position}">${position}</button>`,
  ).join("");
  return `<div class="fantasy-pool__filters fantasy-board__filters">
      <div class="segrow">${pills}</div>
      <input class="fantasy-input" type="text" placeholder="Find a player on your board" value="${esc(filter?.search ?? "")}" data-board-search autocomplete="off" />
    </div>`;
}

// The unmatched report is the point of the import, not an afterthought: a
// paste that quietly dropped eleven names looks like it worked, and the
// manager discovers the hole mid-draft. Every line that did not land is named
// here with why.
function renderImportResult(result) {
  if (!result) return "";
  const bits = [`<p class="note">Matched ${result.order.length} player${result.order.length === 1 ? "" : "s"}${result.tierBreakIds.length ? ` and ${result.tierBreakIds.length} tier break${result.tierBreakIds.length === 1 ? "" : "s"}` : ""}.</p>`];

  if (result.duplicates.length) {
    bits.push(
      `<p class="note--dim">Listed more than once, kept at its first position: ${result.duplicates
        .map((entry) => esc(entry.name))
        .join(", ")}.</p>`,
    );
  }

  if (result.unmatched.length) {
    bits.push(`<div class="fantasy-board-import__unmatched">
        <p class="fantasy-form__error">${result.unmatched.length} line${result.unmatched.length === 1 ? "" : "s"} did not match a player in the pool and ${result.unmatched.length === 1 ? "was" : "were"} left out:</p>
        <ul class="fantasy-board-import__list">${result.unmatched
          .map((entry) => `<li>${esc(entry.name)} <span class="note--dim">${esc(entry.reason)}</span></li>`)
          .join("")}</ul>
      </div>`);
  } else {
    bits.push(`<p class="note--dim">Nothing was dropped.</p>`);
  }

  return `<div class="fantasy-board-import__result">${bits.join("")}</div>`;
}

function renderImport(importOpen, importText, importResult) {
  if (!importOpen) {
    return `<button class="seg" type="button" data-board-import-toggle>Import rankings</button>`;
  }
  return `<section class="fantasy-board-import">
      <p class="note">Paste one player per line. Numbered lists, spreadsheet rows and "Tier 2" separator lines all work. Names are matched loosely, and anything that cannot be matched is listed rather than dropped.</p>
      <textarea class="fantasy-input fantasy-board-import__text" rows="6" data-board-import-text placeholder="1. Erling Haaland&#10;2. Cole Palmer&#10;Tier 2&#10;3. Bukayo Saka">${esc(importText)}</textarea>
      <div class="fantasy-board-import__actions">
        <button class="btn" type="button" data-board-import-apply>Import</button>
        <button class="seg" type="button" data-board-import-toggle>Cancel</button>
      </div>
      ${renderImportResult(importResult)}
    </section>`;
}

// The rows (and their tier headings) only, exported separately so app.js can
// repaint the list on every keystroke in the board's own search box without
// rebuilding - and stealing the caret out of - the input above it. Same split,
// and the same reason, as renderFantasyPlayerRows inside renderFantasyPlayerPool.
export function renderBoardRows(board, rankedPlayers, { draftedIds, filter, noteEditId, compact = false } = {}) {
  const allRows = boardRows(board, rankedPlayers, draftedIds);
  if (!allRows.length) return `<p class="note">The player pool hasn't loaded yet, so there is nothing to rank.</p>`;

  const visible = compact ? windowedRows(allRows, true) : allRows.filter((row) => matchesFilter(row, filter));

  // Tier headings count against the FULL board, never the visible slice:
  // "3 left in Tier 2" has to mean three players, not three players who also
  // happen to be midfielders or to fall inside the compact window.
  const countsByTier = new Map();
  for (const row of allRows) {
    const entry = countsByTier.get(row.tier) ?? { tier: row.tier, total: 0, remaining: 0 };
    entry.total += 1;
    if (!row.taken) entry.remaining += 1;
    countsByTier.set(row.tier, entry);
  }

  let lastTier = null;
  const html = visible
    .map((row) => {
      const head = row.tier !== lastTier ? renderTierHead(countsByTier.get(row.tier)) : "";
      lastTier = row.tier;
      return (
        head +
        renderRow(row, {
          editing: noteEditId != null && noteEditId === row.playerId,
          // Edge-disabling is about the WHOLE board, not this window or this
          // filter: only the actual top of the board has nothing above it.
          isFirst: row.rank === 1,
          isLast: row.rank === allRows.length,
          compact,
        })
      );
    })
    .join("");

  return html || `<p class="note">No players on your board match that filter.</p>`;
}

// The whole board surface. `board` is fantasyDraftBoard.js's stored shape,
// `rankedPlayers` the value-over-replacement-ranked pool (rankedPoolFor), and
// `draftedIds` whoever the league has already taken - empty outside a live
// draft, which makes every row available and the "Gone" markers disappear on
// their own.
//
// `compact` is the draft-room side column: same rows and the same controls,
// but windowed to the live part of the board and without the filter row,
// which a 300px column has no space for and a manager mid-pick has no use
// for. Import and reset stay in both, so the sandbox draft (which has no
// Board tab of its own) is still a complete surface.
export function renderFantasyBoardPanel(
  board,
  rankedPlayers,
  {
    draftedIds,
    filter,
    noteEditId,
    importOpen = false,
    importText = "",
    importResult = null,
    compact = false,
    title = "My board",
  } = {},
) {
  const allRows = boardRows(board, rankedPlayers, draftedIds);
  const current = activeTier(allRows);
  const custom = isCustomBoard(board);
  // Only claim the value-over-replacement order when the pool actually
  // carries the xP that order is computed from. With every xp still null
  // rankDraftPool has nothing to rank on and falls back to alphabetical
  // (see its own comment), and telling a manager their board is sorted by
  // value when it is sorted by surname would be a lie they could check.
  const ranked = (rankedPlayers ?? []).some((player) => player.draftRank != null);
  const subtitle = !allRows.length
    ? ""
    : custom
      ? `${allRows.length} players, your order`
      : ranked
        ? `${allRows.length} players, ranked by value over replacement until you change it`
        : `${allRows.length} players, listed alphabetically until expected points land`;
  const windowed = compact ? windowedRows(allRows, true) : allRows;

  return `<section class="card fantasy-board ${compact ? "fantasy-board--compact" : ""}">
      <div class="fantasy-board__head">
        <h3 class="card__title">${esc(title)}</h3>
        ${current ? `<span class="chip fantasy-board__now">Tier ${current.tier} · ${current.remaining} left</span>` : ""}
      </div>
      ${subtitle ? `<p class="note--dim">${esc(subtitle)}</p>` : ""}
      <div class="fantasy-board__controls">
        ${renderImport(importOpen, importText, importResult)}
        ${custom ? `<button class="seg" type="button" data-board-reset>Reset to value order</button>` : ""}
      </div>
      ${compact ? "" : renderFilters(filter)}
      <div class="fantasy-board__rows" data-board-rows>${renderBoardRows(board, rankedPlayers, { draftedIds, filter, noteEditId, compact })}</div>
      ${compact && allRows.length > windowed.length ? `<p class="note--dim fantasy-board__more">Showing the live part of your board. The My board tab has all ${allRows.length}.</p>` : ""}
    </section>`;
}
