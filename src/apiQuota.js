// API-Football quota accounting.
//
// The Worker proxies a paid API-Football plan, and every upstream call is
// budget. Until now nothing measured that: the daily allowance could be half
// gone by lunchtime and the first anyone would know is a 429 during a live
// match. This module turns each upstream response into a usage record and
// rolls those records up into something worth putting on a dashboard.
//
// The one subtlety that makes naive tracking wrong: the Worker fetches with
// `cf: { cacheEverything: true }`, and a response served from Cloudflare's
// edge cache REPLAYS the stored headers, including the rate-limit ones. So a
// cache hit reports whatever "remaining" was true when the entry was first
// stored, which is stale by construction. Counting those as spend would
// overstate usage, and trusting their `remaining` would make the gauge jump
// backwards. Only a genuine upstream hit is spend, and only a genuine upstream
// hit carries a trustworthy remaining count (see isUpstreamHit).
//
// Pure: no fetch, no DOM, no D1. The Worker records through it and the
// dashboard summarises through it, so both agree on what a request cost.

// Cloudflare's cf-cache-status values that mean we really did go to origin.
// MISS and EXPIRED both reached upstream; a MISS had nothing cached, an
// EXPIRED revalidated. DYNAMIC means Cloudflare declined to cache it at all,
// which still cost a call. Anything else (HIT, and the stale-serving states)
// was answered from cache and cost nothing.
const UPSTREAM_STATUSES = new Set(["miss", "expired", "dynamic", "revalidated", "updating", "bypass"]);

export function isUpstreamHit(cacheStatus) {
  if (!cacheStatus) return true; // no header at all: assume we paid, so the budget errs conservative
  return UPSTREAM_STATUSES.has(String(cacheStatus).trim().toLowerCase());
}

// Collapses a request path to its endpoint family, dropping the query string.
// Without this every fixture id becomes its own series and the table is
// unreadable within a day: "/fixtures?id=560542" and "/fixtures?id=560543" are
// the same endpoint for budgeting purposes, and the id tells us nothing about
// where the money went.
export function endpointFamily(path) {
  if (!path) return "unknown";
  const withoutQuery = String(path).split("?")[0];
  const trimmed = withoutQuery.replace(/\/+$/, "");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

// API-Football sends a daily allowance and a per-minute allowance under
// separate headers, and is inconsistent about casing, so both are read
// case-insensitively. A missing header yields null rather than 0: "we do not
// know" and "none left" must never look the same on a gauge.
export function parseQuotaHeaders(headers) {
  const read = (name) => {
    const raw = headers?.get?.(name);
    if (raw == null || raw === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  return {
    dailyLimit: read("x-ratelimit-requests-limit"),
    dailyRemaining: read("x-ratelimit-requests-remaining"),
    minuteLimit: read("X-RateLimit-Limit"),
    minuteRemaining: read("X-RateLimit-Remaining"),
  };
}

// One request's usage record, ready to be written. `cachedAt` is supplied by
// the caller rather than read from a clock here, so this stays pure and the
// Worker keeps a single source of time.
export function usageRecord({ path, cacheStatus, headers, at }) {
  const upstream = isUpstreamHit(cacheStatus);
  const quota = parseQuotaHeaders(headers);
  return {
    endpoint: endpointFamily(path),
    upstream,
    at,
    // A cached response's quota headers are a replay of whenever it was
    // stored, so they are deliberately dropped rather than recorded as if
    // they described the present.
    dailyLimit: upstream ? quota.dailyLimit : null,
    dailyRemaining: upstream ? quota.dailyRemaining : null,
    minuteLimit: upstream ? quota.minuteLimit : null,
    minuteRemaining: upstream ? quota.minuteRemaining : null,
  };
}

// Rolls a set of records up for the dashboard. `rows` is whatever the store
// hands back, each at minimum { endpoint, upstream, count }.
//
// cacheHitRate is the number worth watching: it is the share of demand the
// edge absorbed, and it is the difference between the current plan being
// comfortable and being breached. A drop in it is the leading indicator that
// a caching change went wrong, long before the daily allowance runs out.
export function summarizeUsage(rows) {
  let upstreamCalls = 0;
  let cachedCalls = 0;
  const byEndpoint = new Map();

  for (const row of rows ?? []) {
    if (!row) continue;
    const count = Number(row.count ?? 1) || 0;
    const entry = byEndpoint.get(row.endpoint) ?? { endpoint: row.endpoint, upstream: 0, cached: 0 };
    if (row.upstream) {
      upstreamCalls += count;
      entry.upstream += count;
    } else {
      cachedCalls += count;
      entry.cached += count;
    }
    byEndpoint.set(row.endpoint, entry);
  }

  const total = upstreamCalls + cachedCalls;
  return {
    upstreamCalls,
    cachedCalls,
    totalCalls: total,
    cacheHitRate: total ? cachedCalls / total : null,
    // Descending by upstream cost: the dashboard's first question is always
    // "what is spending the budget", not "what is busiest".
    endpoints: [...byEndpoint.values()].sort((a, b) => b.upstream - a.upstream || b.cached - a.cached),
  };
}

// Projects where the day ends up, given what has been spent so far and how far
// through the quota window we are. Returns null rather than a guess when there
// is not enough of the day elapsed to extrapolate from, because an
// extrapolation off the first thirty seconds of a day is noise that would
// trigger false alarms every midnight.
export const MIN_ELAPSED_FRACTION_FOR_PROJECTION = 0.05;

export function projectDailyUsage({ used, elapsedFraction, limit }) {
  const spent = Number(used);
  const elapsed = Number(elapsedFraction);
  if (!Number.isFinite(spent) || !Number.isFinite(elapsed)) return null;
  if (elapsed < MIN_ELAPSED_FRACTION_FOR_PROJECTION || elapsed > 1) return null;

  const projected = spent / elapsed;
  const cap = Number(limit);
  return {
    projected: Math.round(projected),
    // Null when we were never told the limit, rather than assuming one: a
    // fabricated ceiling would produce a confident and wrong "you are fine".
    willExceed: Number.isFinite(cap) && cap > 0 ? projected > cap : null,
    headroom: Number.isFinite(cap) && cap > 0 ? Math.round(cap - projected) : null,
  };
}

// The fraction of the quota day elapsed. API-Football's daily allowance resets
// at UTC midnight, so this is deliberately UTC and not the viewer's timezone:
// a dashboard that resets at the user's local midnight would disagree with the
// provider about which day it is and misreport every evening.
export function utcDayFraction(now) {
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) return null;
  const msIntoDay =
    date.getUTCHours() * 3600000 + date.getUTCMinutes() * 60000 + date.getUTCSeconds() * 1000 + date.getUTCMilliseconds();
  return msIntoDay / 86400000;
}
