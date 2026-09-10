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

export function readScoreRoute(hash) {
  if (!/^live(?:\?|$)/.test(hash)) return null;
  const params = new URLSearchParams(hash.split("?")[1] ?? "");
  const date = params.get("date");
  return { date: validScoreDate(date) ? date : null, liveOnly: params.get("live") === "1" };
}

export function scoreRouteHash(date, liveOnly) {
  const params = new URLSearchParams();
  if (validScoreDate(date)) params.set("date", date);
  if (liveOnly) params.set("live", "1");
  return `live${params.size ? `?${params}` : ""}`;
}
