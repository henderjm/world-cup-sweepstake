// The one place the Worker calls Sportmonks. Spend is bounded the same way
// for every caller (the match centre, the Serie A and La Liga feeds):
//   1. In-isolate memo for exactly the ttl the caller declares.
//   2. A floor on Sportmonks' own `rate_limit.remaining` (per entity per hour):
//      below it, calls pause until the hour resets and callers get an error.
//   3. The key travels only in a header, never in a URL that could reach a log.

export const SPORTMONKS_BASE = "https://api.sportmonks.com/v3/football";
export const SPORTMONKS_REMAINING_FLOOR = 200;

const memo = new Map();
let limitedUntil = 0;

// The whole JSON body (data plus pagination) for one path, and when it was
// fetched, so a caller can state the age of what it serves.
export async function sportmonksBody(env, path, ttlMs, now = Date.now()) {
  const hit = memo.get(path);
  // Fresh only within THIS caller's window: a copy cached under a longer ttl
  // must not satisfy a caller that needs it newer (a feed turning live).
  if (hit && hit.expires > now && now - hit.fetchedAt < ttlMs) return hit;
  if (now < limitedUntil) throw Error("sportmonks allowance floor reached");
  const response = await fetch(`${SPORTMONKS_BASE}${path}`, {
    headers: { Authorization: env.SPORTMONKS_API_KEY, Accept: "application/json" },
  });
  const body = await response.json().catch(() => ({}));
  const remaining = Number(body.rate_limit?.remaining);
  if (Number.isFinite(remaining) && remaining < SPORTMONKS_REMAINING_FLOOR) {
    limitedUntil = now + Math.max(60, Number(body.rate_limit?.resets_in_seconds) || 3600) * 1000;
    console.error(`sportmonks: ${remaining} ${body.rate_limit?.requested_entity} calls left, pausing`);
  }
  if (!response.ok) throw Error(`sportmonks ${response.status}`);
  const entry = { body, fetchedAt: now, expires: now + ttlMs };
  memo.set(path, entry);
  if (memo.size > 300) memo.delete(memo.keys().next().value);
  return entry;
}

export async function sportmonks(env, path, ttlMs, now = Date.now()) {
  return (await sportmonksBody(env, path, ttlMs, now)).body.data ?? null;
}

// Every page of a paginated list. Pages share the caller's ttl. Returns the
// rows and the OLDEST page's fetch time, the honest age of the whole list.
export async function sportmonksPages(env, path, ttlMs, now = Date.now(), maxPages = 6) {
  const rows = [];
  let fetchedAt = now;
  for (let page = 1; page <= maxPages; page += 1) {
    const entry = await sportmonksBody(env, `${path}${path.includes("?") ? "&" : "?"}page=${page}`, ttlMs, now);
    rows.push(...(entry.body.data ?? []));
    fetchedAt = Math.min(fetchedAt, entry.fetchedAt);
    if (!entry.body.pagination?.has_more) break;
  }
  return { rows, fetchedAt };
}

export function resetSportmonksClient() {
  memo.clear();
  limitedUntil = 0;
}
