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
  return { counts: new Map(), quota: new Map(), dropped: 0, latestQuota: null, limitedUntil: 0 };
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
    // A separate, STICKY copy of the same reading, kept because the two serve
    // opposite purposes. `quota` above is ledger material: it is drained into
    // D1 and must not be written twice. This is a gauge, read live by the
    // budget guard rail (src/apiBudget.js) to decide what the Worker may still
    // spend, and a gauge that blanked itself every time the ledger flushed
    // would hand the guard rail "unknown" every thirty seconds and make it
    // fail open exactly as often. Same monotonic rule within a day, and a new
    // UTC day replaces it outright because that is the allowance resetting.
    if (!buffer.latestQuota || buffer.latestQuota.day !== day || record.dailyRemaining < buffer.latestQuota.dailyRemaining) {
      buffer.latestQuota = { day, dailyLimit: record.dailyLimit, dailyRemaining: record.dailyRemaining };
    }
  }
  return record;
}

// How long an affirmative refusal from upstream keeps the guard rail at its
// tightest level. Two minutes, chosen to clear API-Football's per-minute window
// with margin rather than to outlast a spent daily allowance: every fresh
// refusal RE-ARMS it, so a genuinely exhausted key stays pinned for as long as
// it keeps being refused (getLive and the fantasy passes are never shed, so they
// keep probing), while a one-minute burst lapses on its own. That re-arming is
// what lets isLimitRejection avoid guessing which of the two it is looking at.
//
// A short window is also the cheap side of the trade. Over-shedding costs a
// missing analysis card and a thinner match drawer for two minutes;
// under-shedding costs the rest of the day's allowance, and getLive is what
// fantasy scoring, waiver runs and the kickoff lock all read.
export const LIMIT_COOLOFF_MS = 2 * 60 * 1000;

// Records that upstream refused us for spend reasons. Kept on the buffer beside
// the sticky gauge, and like it NOT cleared by drainUsage: this is live state
// the budget guard rail reads, not ledger material bound for D1.
export function markUpstreamLimited(buffer, at, cooloffMs = LIMIT_COOLOFF_MS) {
  if (!buffer) return 0;
  const until = Number(at) + cooloffMs;
  if (!Number.isFinite(until)) return buffer.limitedUntil ?? 0;
  // Monotonic, for the same reason the allowance reading is: a refusal seen out
  // of order must never shorten a cool-off a later one already extended.
  buffer.limitedUntil = Math.max(buffer.limitedUntil ?? 0, until);
  return buffer.limitedUntil;
}

// The gauge the budget guard rail reads: the most pessimistic allowance reading
// this isolate has seen today, plus how long any affirmative refusal keeps us
// pinned. Survives drainUsage on purpose (see bufferUsage).
//
// Returns an object when EITHER is present, not just when there is a reading.
// A cold isolate that has never seen a quota header and is then refused outright
// is precisely the case that matters, and returning null there would hand the
// guard rail "unknown" and make it fail open through the refusal.
export function latestQuota(buffer) {
  const snapshot = buffer?.latestQuota ?? null;
  const limitedUntil = buffer?.limitedUntil ?? 0;
  if (!snapshot && !limitedUntil) return null;
  return { ...(snapshot ?? {}), limitedUntil };
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
  // buffer.latestQuota is deliberately NOT cleared: it is a gauge, not a
  // ledger entry, and the guard rail that reads it needs it between flushes.
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
      // Whether upstream is refusing us for spend reasons RIGHT NOW. The
      // headers alone cannot say: a refused response carries none, so the
      // figures above are the last good reading and look healthy through the
      // incident. This is the flag that tells an operator which they are
      // looking at.
      limited: Boolean(quota?.limitedUntil && now < quota.limitedUntil),
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
