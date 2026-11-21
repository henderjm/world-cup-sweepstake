// HTML-string renderers for The Wire panel on the Scores page. Pure: the state
// comes in, markup goes out, and app.js owns fetching, polling and the
// surgical repaint of [data-wire-list] (the same split as fantasyChatView.js).
//
// Every row carries data-match-id, so the existing delegated click handler
// opens the match drawer from any line of commentary with no new wiring.

import { abbrFor } from "./badges.js";
import { isLive } from "./format.js";
import { followsTeam } from "./teamFollows.js";
import {
  WIRE_KINDS,
  describeImpact,
  describeWireItem,
  isBigMoment,
  isRedCard,
  minuteLabel,
  sortWireItems,
  wirePulse,
} from "./liveWire.js";

export const WIRE_FILTERS = [
  { key: "all", label: "Everything" },
  { key: "big", label: "Big moments" },
  { key: "following", label: "My teams" },
];
export const WIRE_COLLAPSED = 8;
export const WIRE_EXPANDED = 80;

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

// Which items a filter shows. "My teams" with no follows shows nothing, and
// the panel says why rather than looking empty for no reason.
export function filterWireItems(items, { filter = "all", follows = [], competition = null } = {}) {
  return sortWireItems(items).filter(item => {
    if (competition && item.competition !== competition) return false;
    if (filter === "big") return isBigMoment(item) || item.kind === WIRE_KINDS.FULL_TIME;
    if (filter === "following") {
      return followsTeam(follows, item.competition, item.homeTeam) || followsTeam(follows, item.competition, item.awayTeam);
    }
    return true;
  });
}

function markFor(item) {
  if (item.kind === WIRE_KINDS.GOAL) return item.overturned ? "void" : "goal";
  if (item.kind === WIRE_KINDS.CARD) return isRedCard(item) ? "red" : "yellow";
  if (item.kind === WIRE_KINDS.OVERTURNED) return "void";
  if (item.kind === WIRE_KINDS.SUB) return "sub";
  return "whistle";
}

function renderItem(item, { fresh = new Set(), follows = [] } = {}) {
  const { headline, line } = describeWireItem(item);
  // A ruled-out goal moved nobody up the table, so its old chip is not shown.
  const impact = item.overturned ? null : describeImpact(item);
  const followed = followsTeam(follows, item.competition, item.homeTeam) || followsTeam(follows, item.competition, item.awayTeam);
  const big = isBigMoment(item);
  const classes = [
    "wire__item", `wire__item--${markFor(item)}`,
    big ? "is-big" : "", fresh.has(item.key) ? "is-new" : "", followed ? "is-followed" : "",
    item.overturned ? "is-overturned" : "",
  ].filter(Boolean).join(" ");
  const ai = item.ai
    ? `<p class="wire__ai"><span class="wire__aichip" title="Written by Claude from the facts above. It can slip up.">AI</span>${esc(item.ai)}</p>`
    : item.aiPending ? `<p class="wire__ai wire__ai--pending" aria-hidden="true"><span class="wire__aichip">AI</span><span class="wire__shimmer"></span></p>` : "";
  return `<li class="${classes}" data-match-id="${esc(item.matchId)}" role="button" tabindex="0">
    <span class="wire__min">${esc(minuteLabel(item))}</span>
    <span class="wire__mark" aria-hidden="true"></span>
    <div class="wire__body">
      <p class="wire__match"><span class="wire__comp">${esc(item.competition)}</span>${esc(abbrFor(item.homeTeam))} v ${esc(abbrFor(item.awayTeam))}</p>
      <p class="wire__headline">${esc(headline)}${item.overturned ? ' <span class="wire__flag">Ruled out</span>' : ""}</p>
      <p class="wire__line">${esc(line)}</p>
      ${impact ? `<p class="wire__impact">${impact.includes(" up to ") ? "▲" : "▼"} ${esc(impact)}</p>` : ""}
      ${ai}
    </div>
  </li>`;
}

// Just the timeline, for the poll's surgical repaint.
export function renderWireList(items, options = {}) {
  const { expanded = false, filter = "all", follows = [] } = options;
  const visible = filterWireItems(items, options);
  if (!visible.length) {
    const why = filter === "following"
      ? (follows.length ? "Nothing from your teams yet tonight." : "Follow a team to see only their moments here.")
      : filter === "big" ? "No goals or red cards yet." : "Commentary starts at kick-off.";
    return `<p class="wire__empty">${why}</p>`;
  }
  const limit = expanded ? WIRE_EXPANDED : WIRE_COLLAPSED;
  const rows = visible.slice(0, limit).map(item => renderItem(item, options)).join("");
  const more = visible.length > WIRE_COLLAPSED
    ? `<button class="wire__more" type="button" data-wire-expand>${expanded ? "Show less" : `Show all ${Math.min(visible.length, WIRE_EXPANDED)}`}</button>`
    : "";
  return `<ol class="wire__list">${rows}</ol>${more}`;
}

export function renderWirePulse(matches, items, now = Date.now()) {
  const pulse = wirePulse(matches, items, now);
  if (!pulse) return "";
  return `<button class="wire__pulse" type="button" data-match-id="${esc(pulse.matchId)}">
    <span class="wire__pulselabel">Watch now</span>
    <span class="wire__pulsematch">${esc(abbrFor(pulse.homeTeam))} ${pulse.score.home}–${pulse.score.away} ${esc(abbrFor(pulse.awayTeam))}</span>
    <span class="wire__pulsewhy">${esc(pulse.reason)}</span>
  </button>`;
}

// The whole panel. Rendered only on a day with commentary (or live matches
// about to produce some); app.js decides that, this just draws it.
export function renderWirePanel({ items = [], matches = [], filter = "all", expanded = false, follows = [], fresh = new Set(), competition = null, error = false, now = Date.now() } = {}) {
  const anyLive = matches.some(match => isLive(match.status));
  const filters = WIRE_FILTERS.map(option => `<button class="seg${option.key === filter ? " is-active" : ""}" type="button" data-wire-filter="${option.key}" aria-pressed="${option.key === filter}">${option.label}</button>`).join("");
  return `<section class="card wire" data-wire aria-label="Live commentary">
    <header class="wire__head">
      <h2 class="wire__title"><span class="wire__dot${anyLive ? " is-live" : ""}" aria-hidden="true"></span>The Wire</h2>
      <p class="wire__sub">${anyLive ? "Live commentary from every ground" : "Tonight's commentary"}</p>
    </header>
    <div data-wire-pulse>${renderWirePulse(matches, items, now)}</div>
    <div class="segrow wire__filters" role="group" aria-label="Filter commentary">${filters}</div>
    ${error ? '<p class="wire__empty">Commentary is catching up. Scores below are unaffected.</p>' : ""}
    <div data-wire-list aria-live="polite">${renderWireList(items, { expanded, filter, follows, fresh, competition })}</div>
  </section>`;
}
