// Shared formatting helpers. Pure, no DOM.

const LIVE_STATUSES = new Set([
  "IN_PLAY",
  "PAUSED",
  "LIVE",
  "EXTRA_TIME",
  "PENALTY_SHOOTOUT",
  "BREAK",
]);

export function money(value) {
  return new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

export function signed(value) {
  return value > 0 ? `+${value}` : String(value);
}

export function percent(value) {
  if (!Number.isFinite(value)) return "0%";
  if (value > 0 && value < 1) return "<1%";
  return `${Math.round(value)}%`;
}

export function dateLabel(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-IE", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function dayLabel(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-IE", {
    weekday: "short",
    day: "2-digit",
    month: "short",
  }).format(new Date(value));
}

export function timeLabel(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-IE", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatStage(stage) {
  if (!stage) return "";
  const map = {
    REGULAR_SEASON: "League",
    GROUP_STAGE: "Group stage",
    LEAGUE_STAGE: "League phase",
    LAST_32: "Round of 32",
    ROUND_OF_32: "Round of 32",
    LAST_16: "Round of 16",
    ROUND_OF_16: "Round of 16",
    PLAYOFFS: "Knockout play-off",
    QUARTER_FINALS: "Quarter-final",
    SEMI_FINALS: "Semi-final",
    THIRD_PLACE: "Third place",
    FINAL: "Final",
  };
  return (
    map[stage] ??
    String(stage)
      .replace(/_/g, " ")
      .toLowerCase()
      .replace(/\b\w/g, (letter) => letter.toUpperCase())
  );
}

// Football's own order for a list of players: keeper, defence, midfield,
// attack. A bench read in any other order (the provider's, or the order a
// squad happened to be drafted in) reads as unsorted, because every other
// place the sport lists players uses this one.
//
// Keyed on the first letter rather than an exact string on purpose: the same
// four positions arrive spelled three ways in this codebase - API-Football's
// "G"/"D"/"M"/"F", the football-data.org era's "Goalkeeper"/"Defence"/
// "Midfield"/"Offence" still sitting in the committed seed files, and the
// fantasy pool's own "GK"/"DEF"/"MID"/"FWD" - and a lookup table would have to
// list all of them and then silently fail on the fourth spelling. "Attacker"
// is the one word that does not share its initial with the group it belongs
// to, so it is mapped explicitly.
//
// An unknown or missing position sorts LAST rather than first: API-Football
// leaves `pos` null on some substitutes, and a gap in the feed must never push
// an unlabelled player above the goalkeeper.
const POSITION_RANK = { G: 0, D: 1, M: 2, F: 3, A: 3, O: 3 };
export const UNKNOWN_POSITION_RANK = 4;

export function positionRank(pos) {
  const initial = String(pos ?? "").trim().charAt(0).toUpperCase();
  return POSITION_RANK[initial] ?? UNKNOWN_POSITION_RANK;
}

// Sorts a copy, and Array.prototype.sort is stable, so players sharing a
// position keep whatever order they arrived in (the provider's own listing for
// a club's bench, draft order for a fantasy squad). `position` covers the
// fantasy pool's field name, `pos` the mapped feed's.
export function byPosition(a, b) {
  return positionRank(a?.position ?? a?.pos) - positionRank(b?.position ?? b?.pos);
}

export function isLive(status) {
  return LIVE_STATUSES.has(status);
}

export function isFinished(status) {
  return status === "FINISHED" || status === "AWARDED";
}

export function statusLabel(matchItem) {
  if (isLive(matchItem.status)) return matchItem.minute ? `${matchItem.minute}'` : "LIVE";
  if (isFinished(matchItem.status)) return "FT";
  return timeLabel(matchItem.utcDate);
}

export function scorePart(score, side) {
  return Number.isFinite(score?.[side]) ? score[side] : "";
}

// The "updated" chip in the header.
//
// Normally this is the age of our last SUCCESSFUL fetch, which is what a reader
// means by "is what I am looking at current". That was the only thing it ever
// reported, and it made a specific failure invisible: when the Worker's upstream
// is down it serves its own last-known-good copy (see src/liveStale.js), so we
// really did just fetch, and what came back was old. The chip said "just now"
// over a frozen scoreline, which is the most confident possible way to be wrong.
//
// So when the feed reports itself stale, the DATA's age is what gets shown, and
// it is named as delayed rather than left to be read as a slow poll. The age is
// the staleness the Worker measured plus however long ago we fetched it, because
// both have elapsed since the data was actually current.
export function updatedLabel({ fetchedAt, now = Date.now(), staleAgeMs = null } = {}) {
  if (!fetchedAt) return { text: "loading", delayed: false };
  const sinceFetch = Math.max(0, now - fetchedAt);
  const delayed = Number.isFinite(staleAgeMs) && staleAgeMs !== null;
  const age = delayed ? staleAgeMs + sinceFetch : sinceFetch;
  // Phrased to read correctly after the static "Updated" label in App.svelte:
  // "Updated 14m ago (delayed)", not "Updated delayed 14m ago".
  return { text: delayed ? `${relativeAge(age)} (delayed)` : relativeAge(age), delayed };
}

// Seconds up to a minute, minutes up to an hour, then the wall-clock time, which
// past an hour is more use than a growing minute count.
function relativeAge(ms) {
  const secs = Math.round(ms / 1000);
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return new Intl.DateTimeFormat("en-IE", { hour: "2-digit", minute: "2-digit" }).format(
    new Date(Date.now() - ms),
  );
}
