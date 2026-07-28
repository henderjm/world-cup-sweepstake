// The buffering and reporting layer around the pure maths in apiQuota.js.
//
// apiQuota.js turns one upstream response into a usage record and knows how to
// summarise and project a set of them. It says nothing about where records
// live between the fetch that produced them and the dashboard that reads them.
// That is this module's job, and it exists because the naive answer is
// unaffordable: the Worker's single upstream chokepoint (fetchJson) runs on
// every proxied call, so a row per request would put a D1 write in front of
// every poll of a live match. Instead records accumulate in memory keyed by
// (day, endpoint, upstream) and are flushed as counts, which collapses
// thousands of requests into at most a handful of rows.
//
// What that costs, stated plainly rather than hidden: a Worker isolate can be
// evicted with a buffer still in it, so the absolute counts are a FLOOR, not a
// ledger. The number the dashboard leads on is the cache hit rate, and a rate
// survives this: eviction is uncorrelated with whether a given call was served
// from cache, so the ratio stays honest even when the totals undercount. The
// daily projection is deliberately anchored on the provider's own remaining
// count where we have one (see reportedUsage below) precisely because that
// figure does not depend on our buffer surviving.
//
// Pure: no fetch, no D1, no clock. The caller supplies time and does the I/O.

import { projectDailyUsage, summarizeUsage, usageRecord, utcDayFraction } from "./apiQuota.js";

// A ceiling on distinct (day, endpoint, upstream) keys held in one buffer.
// endpointFamily already strips query strings, so in practice this sits at
// well under twenty keys; the cap only matters if a future caller starts
// passing something id-shaped through as a path, and it turns that mistake
// into a slightly incomplete chart rather than an isolate that grows until it
// is killed.
export const MAX_BUFFER_KEYS = 200;

// The quota day is UTC because API-Football's daily allowance resets at UTC
// midnight (the same reasoning as utcDayFraction). Any other day boundary
// would file spend under the wrong day for part of every evening.
export function usageDay(at) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export function createUsageBuffer() {
  return { counts: new Map(), quota: new Map(), dropped: 0 };
}

// Folds one upstream response into the buffer. Returns the record so a caller
// can log or assert on it; the buffer itself is mutated in place because this
// runs on the hot path of every proxied request.
export function bufferUsage(buffer, { path, cacheStatus, headers, at }) {
  const record = usageRecord({ path, cacheStatus, headers, at });
  const day = usageDay(at);
  if (!day) return record;

  const key = `${day}|${record.endpoint}|${record.upstream ? 1 : 0}`;
  const existing = buffer.counts.get(key);
  if (existing) {
    existing.count += 1;
  } else if (buffer.counts.size >= MAX_BUFFER_KEYS) {
    buffer.dropped += 1;
    return record;
  } else {
    buffer.counts.set(key, { day, endpoint: record.endpoint, upstream: record.upstream, count: 1 });
  }

  // Only a genuine upstream hit carries a trustworthy remaining count, and
  // usageRecord has already nulled the replayed ones. Of the trustworthy ones
  // keep the LOWEST remaining seen today: within a UTC day the provider's
  // counter only ever falls, so a higher reading is either an out-of-order
  // flush from another isolate or a reset we should not believe yet, and
  // taking the minimum means the gauge can never appear to refill mid-day.
  if (record.dailyRemaining != null) {
    const seen = buffer.quota.get(day);
    if (!seen || record.dailyRemaining < seen.dailyRemaining) {
      buffer.quota.set(day, { day, dailyLimit: record.dailyLimit, dailyRemaining: record.dailyRemaining });
    }
  }
  return record;
}

// Empties the buffer and hands back what was in it. Draining rather than
// copying is what makes a flush safe to lose halfway: whatever a failed write
// took with it is gone, which undercounts, where re-flushing a copy that
// already landed would double-count. An undercount degrades a chart; a
// double-count would make the projection cry wolf.
export function drainUsage(buffer) {
  const rows = [...buffer.counts.values()];
  const quota = [...buffer.quota.values()];
  buffer.counts.clear();
  buffer.quota.clear();
  buffer.dropped = 0;
  return { rows, quota };
}

export function bufferSize(buffer) {
  let total = 0;
  for (const entry of buffer.counts.values()) total += entry.count;
  return total;
}

// Splits rows so no single D1 statement group exceeds the 100 bound-parameter
// cap. In practice a drain is a handful of rows, but the cap is a cliff rather
// than a slowdown, so the chunking is unconditional instead of relying on the
// row count staying small.
export function chunkRows(rows, paramsPerRow, maxParams = 100) {
  const perChunk = Math.max(1, Math.floor(maxParams / Math.max(1, paramsPerRow)));
  const chunks = [];
  for (let i = 0; i < rows.length; i += perChunk) chunks.push(rows.slice(i, i + perChunk));
  return chunks;
}

// How close to the ceiling counts as a warning rather than "fine". Ten percent
// of a day's allowance is roughly the last hour of a normal day's spend, which
// is enough notice to turn something off before a live match runs into a 429.
export const TIGHT_HEADROOM_FRACTION = 0.1;

// Which "used" figure the projection extrapolates from.
//
// Preferring the provider's own (limit - remaining) over our counted upstream
// calls is not a rounding preference. The API key is spent by more than this
// Worker: the hourly GitHub Action bake and the fantasy player-pool script
// draw on the same allowance, and neither passes through fetchJson. A
// projection built only on what we counted would read comfortable right up to
// the moment the key was exhausted by something we never see.
export function reportedUsage(quota, countedUpstream) {
  const limit = Number(quota?.dailyLimit);
  const remaining = Number(quota?.dailyRemaining);
  if (Number.isFinite(limit) && Number.isFinite(remaining) && limit > 0) {
    return { used: limit - remaining, source: "provider" };
  }
  return { used: countedUpstream, source: "counted" };
}

// The whole dashboard payload, assembled from stored rows. `rows` is whatever
// the store hands back for the day ({ endpoint, upstream, count }); `quota` is
// the day's last known allowance headers, or null if none was ever recorded.
export function buildQuotaReport({ rows, quota, now }) {
  const usage = summarizeUsage(rows);
  const elapsedFraction = utcDayFraction(now);
  const { used, source } = reportedUsage(quota, usage.upstreamCalls);
  const projection = projectDailyUsage({ used, elapsedFraction, limit: quota?.dailyLimit });

  return {
    day: usageDay(now),
    ...usage,
    quota: {
      dailyLimit: quota?.dailyLimit ?? null,
      dailyRemaining: quota?.dailyRemaining ?? null,
      used,
      // Names which figure the projection is built on, so a reader can tell
      // "we measured this" from "the provider told us".
      usedSource: source,
    },
    projection: projection
      ? { ...projection, elapsedFraction, verdict: quotaVerdict(projection, quota?.dailyLimit) }
      : // Null, not a guess. Too little of the day has elapsed to extrapolate
        // from (see MIN_ELAPSED_FRACTION_FOR_PROJECTION), and a number invented
        // out of the first minutes after midnight would raise an alarm daily.
        { projected: null, willExceed: null, headroom: null, elapsedFraction, verdict: "unknown" },
  };
}

function quotaVerdict(projection, limit) {
  if (projection.willExceed === null) return "unknown";
  if (projection.willExceed) return "over";
  const cap = Number(limit);
  if (!Number.isFinite(cap) || cap <= 0) return "unknown";
  return projection.headroom < cap * TIGHT_HEADROOM_FRACTION ? "tight" : "ok";
}
