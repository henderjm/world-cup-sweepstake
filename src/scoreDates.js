import { COMPETITIONS } from "./competitions.js";

export function localDateKey(value = Date.now()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function validScoreDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) return false;
  return localDateKey(`${value}T12:00:00`) === value;
}

export function shiftScoreDate(value, days) {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + days);
  return localDateKey(date);
}

export const SCORES_TABS = ["live", "tables", "knockout", "fixtures", "predict", "stats"];

export function readScoreRoute(hash) {
  const tab = hash.split("?")[0];
  if (!SCORES_TABS.includes(tab)) return null;
  const params = new URLSearchParams(hash.split("?")[1] ?? "");
  const date = params.get("date");
  const phase = ["main", "qualifying"].includes(params.get("phase")) ? params.get("phase") : null;
  const round = /^[A-Z0-9_]{1,60}$/.test(params.get("round") ?? "") ? params.get("round") : null;
  return { tab, phase, round, followingOnly: params.get("following") === "1", date: validScoreDate(date) ? date : null, liveOnly: params.get("live") === "1", competition: Object.hasOwn(COMPETITIONS, params.get("competition")) ? params.get("competition") : null };
}

export function scoreRouteHash({ date = null, liveOnly = false, competition = null, tab = "live", followingOnly = false, phase = null, round = null } = {}) {
  const params = new URLSearchParams();
  if (validScoreDate(date)) params.set("date", date);
  if (liveOnly) params.set("live", "1");
  if (followingOnly) params.set("following", "1");
  if (Object.hasOwn(COMPETITIONS, competition)) params.set("competition", competition);
  if (tab === "knockout") {
    if (["main", "qualifying"].includes(phase)) params.set("phase", phase);
    if (/^[A-Z0-9_]{1,60}$/.test(round ?? "")) params.set("round", round);
  }
  return `${SCORES_TABS.includes(tab) ? tab : "live"}${params.size ? `?${params}` : ""}`;
}

// Days the Scores strip offers: only days on which a tracked competition
// actually plays, so the strip is a list of matchdays rather than a calendar
// full of blanks. Today is always present (it is where the app opens, and an
// empty today still says "no kick-offs today, next is..."), and so is the
// selected day, so a deep link to a quiet date still shows where you are.
export const MATCH_DAYS_BEFORE = 2;
export const MATCH_DAYS_AFTER = 5;

export function matchDays(matches = []) {
  return [...new Set(matches.map(match => match?.utcDate && localDateKey(match.utcDate)).filter(Boolean))].sort();
}

export function matchDayStrip(days, selected, today = localDateKey()) {
  const past = days.filter(day => day < today).slice(-MATCH_DAYS_BEFORE);
  const future = days.filter(day => day > today).slice(0, MATCH_DAYS_AFTER);
  return [...new Set([...past, today, ...future, selected])].filter(Boolean).sort();
}

// The neighbouring matchday for a swipe, skipping empty dates. Returns null at
// either end of the season rather than walking into a blank calendar.
export function adjacentMatchDay(days, from, direction) {
  const candidates = [...new Set([...days, localDateKey()])].sort();
  return direction > 0
    ? candidates.find(day => day > from) ?? null
    : candidates.filter(day => day < from).at(-1) ?? null;
}
