// League feed renderers: HTML strings, delegated events, same contract as
// fantasyView.js and fantasyWaiversView.js.
//
// ONE timeline. A manager's message, a waiver run and the AI recap are all
// rows in the same scroll, deliberately: league chat that lives beside the
// transaction log instead of inside it is the version managers abandon for
// WhatsApp. The whole point is that a move and the reaction to it sit next to
// each other.

import { CHAT_REACTIONS, describeChatEvent, isRecapEntry } from "./fantasyChat.js";
import { dateLabel } from "./format.js";

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

// Movement arrow for a power ranking. Null (a manager who was not ranked last
// week) is a dash, never a zero: "new entry" and "held station" are different
// facts and the reader should be able to tell them apart.
function movementChip(movement) {
  if (movement == null) return `<span class="fantasy-recap-move fantasy-recap-move--new">new</span>`;
  if (movement === 0) return `<span class="fantasy-recap-move">·</span>`;
  const up = movement > 0;
  return `<span class="fantasy-recap-move ${up ? "is-up" : "is-down"}">${up ? "▲" : "▼"}${Math.abs(movement)}</span>`;
}

// The recap card. Every number here came from the Worker's own computation
// (see src/fantasyRecap.js); the model only ever wrote the prose fields, so a
// bland or missing note still leaves a correct, useful card.
export function renderRecapCard(recap) {
  const rankings = (recap?.rankings ?? [])
    .map(
      (row) => `
        <li class="fantasy-recap-rank">
          <span class="fantasy-recap-rank__pos">${esc(row.rank)}</span>
          ${movementChip(row.movement)}
          <span class="fantasy-recap-rank__body">
            <strong>${esc(row.name)}</strong>
            <span class="note--dim">${esc(row.record)} · power ${esc(row.powerScore)}</span>
            ${row.note ? `<span class="fantasy-recap-rank__note">${esc(row.note)}</span>` : ""}
          </span>
        </li>`,
    )
    .join("");

  const awards = (recap?.awards ?? [])
    .map(
      (award) => `
        <li class="fantasy-recap-award">
          <span class="fantasy-recap-award__title">${esc(award.title)}</span>
          <strong>${esc(award.name)}</strong>
          <span class="note--dim">${esc(award.detail)}</span>
          ${award.note ? `<span class="fantasy-recap-award__note">${esc(award.note)}</span>` : ""}
        </li>`,
    )
    .join("");

  const results = (recap?.results ?? [])
    .map(
      (result) => `
        <li class="fantasy-recap-result">
          <span>${esc(result.home)}</span>
          <strong>${esc(result.homeScore)} - ${esc(result.awayScore)}</strong>
          <span>${esc(result.away)}</span>
        </li>`,
    )
    .join("");

  return `
    <div class="card fantasy-recap">
      <p class="fantasy-eyebrow">Gameweek ${esc(recap?.gameweek)} recap</p>
      <h3 class="fantasy-recap__headline">${esc(recap?.headline)}</h3>
      ${recap?.matchups ? `<p class="fantasy-recap__prose">${esc(recap.matchups)}</p>` : ""}
      ${results ? `<ul class="fantasy-recap-results">${results}</ul>` : ""}
      ${rankings ? `<h4 class="fantasy-recap__subhead">Power rankings</h4><ol class="fantasy-recap-ranks">${rankings}</ol>` : ""}
      ${awards ? `<h4 class="fantasy-recap__subhead">Awards</h4><ul class="fantasy-recap-awards">${awards}</ul>` : ""}
      ${recap?.lookahead ? `<p class="fantasy-recap__prose fantasy-recap__lookahead">${esc(recap.lookahead)}</p>` : ""}
      <p class="note--dim fantasy-recap__footnote">Numbers computed from your league's results. Words by Claude.</p>
    </div>`;
}

function renderReactions(entry, signedIn) {
  const counts = entry?.reactions?.counts ?? {};
  const mine = new Set(entry?.reactions?.mine ?? []);
  // Only the emoji somebody has actually used are shown at rest, plus an "add"
  // control: six always-on buttons per row would bury a busy feed.
  const used = CHAT_REACTIONS.filter((emoji) => (counts[emoji] ?? 0) > 0);
  const chips = used
    .map(
      (emoji) =>
        `<button type="button" class="bn-react fantasy-feed-react ${mine.has(emoji) ? "is-mine" : ""}" data-feed-react="${esc(emoji)}" data-feed-message="${esc(entry.id)}" aria-pressed="${mine.has(emoji)}" ${signedIn ? "" : "disabled"}>${emoji}<span>${counts[emoji]}</span></button>`,
    )
    .join("");
  const picker = CHAT_REACTIONS.map(
    (emoji) =>
      `<button type="button" class="fantasy-feed-pick" data-feed-react="${esc(emoji)}" data-feed-message="${esc(entry.id)}" title="React ${emoji}">${emoji}</button>`,
  ).join("");

  return `
    <div class="fantasy-feed-reactions">
      ${chips}
      <details class="fantasy-feed-addreact">
        <summary aria-label="Add a reaction">+</summary>
        <div class="fantasy-feed-picker">${picker}</div>
      </details>
    </div>`;
}

// One row. A system event is described at read time from its stored facts
// (describeChatEvent), never from prose frozen into the database.
function renderEntry(entry, { myUserId, signedIn }) {
  const stamp = entry.ts ? `<time class="fantasy-feed-row__ts">${esc(dateLabel(entry.ts))}</time>` : "";

  if (isRecapEntry(entry)) {
    return `
      <li class="fantasy-feed-row fantasy-feed-row--recap">
        ${renderRecapCard(entry.payload.recap)}
        ${renderReactions(entry, signedIn)}
      </li>`;
  }

  if (entry.kind === "system") {
    const described = describeChatEvent(entry);
    return `
      <li class="fantasy-feed-row fantasy-feed-row--system">
        <span class="fantasy-feed-row__icon" aria-hidden="true">${described.icon}</span>
        <span class="fantasy-feed-row__body">
          <span class="fantasy-feed-row__event">${esc(described.text)}</span>
          ${stamp}
          ${renderReactions(entry, signedIn)}
        </span>
      </li>`;
  }

  const mine = entry.userId != null && entry.userId === myUserId;
  return `
    <li class="fantasy-feed-row fantasy-feed-row--message ${mine ? "is-mine" : ""} ${entry.pending ? "is-pending" : ""}">
      <span class="fantasy-feed-row__body">
        <span class="fantasy-feed-row__who"><strong>${esc(entry.name)}</strong>${stamp}</span>
        <span class="fantasy-feed-row__text">${esc(entry.text)}</span>
        ${entry.pending ? "" : renderReactions(entry, signedIn)}
      </span>
    </li>`;
}

// Just the rows, so a poll can refresh the timeline in place without blowing
// away a half-typed message or the scroll position (the same surgical-update
// pattern renderFantasyFreeAgentRows uses for the waivers lists).
export function renderFeedEntries(entries, { myUserId = null, signedIn = true } = {}) {
  if (!entries?.length) {
    return `<li class="fantasy-feed-empty"><p class="note">Nothing here yet. Every pick, claim and lineup change lands here.</p></li>`;
  }
  return entries.map((entry) => renderEntry(entry, { myUserId, signedIn })).join("");
}

// The whole panel. `chat` is the GET /fantasy/league/:id/chat response, or null
// while the first load is in flight.
export function renderFantasyFeedPanel(chat, { myUserId = null, error = "", signedIn = true } = {}) {
  if (!chat) {
    return error
      ? `<div class="card"><p class="fantasy-form__error">${esc(error)}</p><button class="seg" type="button" data-feed-retry>Retry</button></div>`
      : `<p class="note">Loading the league feed…</p>`;
  }

  const compose = signedIn
    ? `<form class="fantasy-feed-compose" data-feed-form>
         <input class="fantasy-feed-input" data-feed-text maxlength="280" placeholder="say something…" autocomplete="off" aria-label="Message your league" />
         <button class="btn btn--primary fantasy-feed-send" type="submit">Send</button>
       </form>`
    : "";

  return `
    <section class="card fantasy-feed">
      ${error ? `<p class="fantasy-form__error">${esc(error)}</p>` : ""}
      <ul class="fantasy-feed-list" data-feed-list>${renderFeedEntries(chat.entries, { myUserId, signedIn })}</ul>
      ${compose}
    </section>`;
}
