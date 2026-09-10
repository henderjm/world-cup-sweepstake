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
  return { tab, followingOnly: params.get("following") === "1", date: validScoreDate(date) ? date : null, liveOnly: params.get("live") === "1", competition: Object.hasOwn(COMPETITIONS, params.get("competition")) ? params.get("competition") : null };
}

export function scoreRouteHash(date, liveOnly, competition = null, tab = "live", followingOnly = false) {
  const params = new URLSearchParams();
  if (validScoreDate(date)) params.set("date", date);
  if (liveOnly) params.set("live", "1");
  if (followingOnly) params.set("following", "1");
  if (Object.hasOwn(COMPETITIONS, competition)) params.set("competition", competition);
  return `${SCORES_TABS.includes(tab) ? tab : "live"}${params.size ? `?${params}` : ""}`;
}
