// A deterministic, in-process response memo for the Worker's single upstream
// chokepoint (fetchJson in worker/worker.js).
//
// Why this exists, stated as the measurement that motivated it: one cron tick
// calls getLive EIGHT times (the analysis and notification passes once per
// configured competition, then the scoring, waiver, xP-blend and recap passes
// once each for PL), and every one of those issues the same season-schedule and
// standings URLs. That is 16 identical upstream requests a minute in a
// pre-season week where nothing whatsoever has changed. The code was not
// unaware of this: several call sites carry comments saying they "reuse the
// same fetch" and "ride the edge cache". The flaw is that those comments
// describe a HOPE about Cloudflare's edge cache rather than a property of this
// program. Nothing here guaranteed it, and production said it was not holding:
// with a 7,500/day allowance the projection came in at 12,282 while the season
// had not started and no match had been live all day.
//
// So the dedup is made a property of the program instead. The window used is
// the SAME cf.cacheTtl the call site already declares, which is what makes this
// safe by construction: this module can never serve a response older than the
// caller already told Cloudflare it was willing to accept. Live scores stay
// exactly as fresh as they were, because the batched live-fixture request
// declares a 60-second window and still gets one.
//
// The edge cache is not replaced, it is demoted: when it works we now never ask
// it, and when it does not we no longer pay for the miss eight times over.
//
// INVARIANT: a cached payload is shared by reference with every caller, so
// consumers must treat an upstream payload as READ-ONLY. Every current consumer
// does (the mappers in mapApiFootball.js build new objects and never write back
// into the payload, and assertApiFootballPayload only reads). A future consumer
// that mutates a payload in place would corrupt every later reader of the same
// URL within the window, which is why it is written down here rather than left
// to be discovered.
//
// Pure: no fetch, no clock, no globals. The caller supplies time and does the
// I/O, the same split as apiQuota.js and apiQuotaStore.js.

// A ceiling on distinct URLs held at once. A tick touches a handful (two
// schedules, two standings tables, one batched live request, three payloads per
// live match), so this only binds on a busy matchday with many live fixtures,
// and it binds by evicting the oldest rather than by growing without limit.
// An isolate that loses an entry pays one extra upstream call, which is the
// behaviour that existed before this module.
export const MAX_CACHE_ENTRIES = 96;

// Nothing may be held longer than the longest window any call site declares
// (the six-hour season schedule). A clamp rather than trust, so a future caller
// passing a nonsense ttl cannot pin a stale payload in memory for a season.
export const MAX_TTL_SECONDS = 6 * 60 * 60;

export function createResponseCache() {
  return { entries: new Map(), hits: 0, misses: 0, evictions: 0 };
}

// The stored payload if it is still inside its window, otherwise undefined.
// Undefined rather than null because null is a payload a caller could
// legitimately have stored, and "we hold nothing" must not be confusable with
// "we hold nothing useful".
export function readCached(cache, key, now) {
  const entry = cache?.entries?.get(key);
  if (!entry) {
    if (cache) cache.misses += 1;
    return undefined;
  }
  if (entry.expires <= now) {
    cache.entries.delete(key);
    cache.misses += 1;
    return undefined;
  }
  // Re-inserted so Map iteration order is least-recently-USED first, which is
  // what makes the eviction below evict the right thing. Without this a hot
  // URL fetched once at isolate start would be the first entry dropped.
  cache.entries.delete(key);
  cache.entries.set(key, entry);
  cache.hits += 1;
  return entry.value;
}

// A non-positive or unparseable ttl stores nothing at all. That is deliberate:
// a call site that declined to declare a cache window is asking for a fresh
// read, and inventing a window for it here would silently change its meaning.
export function writeCached(cache, key, value, ttlSeconds, now) {
  const ttl = Number(ttlSeconds);
  if (!cache || !Number.isFinite(ttl) || ttl <= 0) return false;
  const bounded = Math.min(ttl, MAX_TTL_SECONDS);

  cache.entries.delete(key);
  while (cache.entries.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.entries.keys().next().value;
    if (oldest === undefined) break;
    cache.entries.delete(oldest);
    cache.evictions += 1;
  }
  cache.entries.set(key, { value, expires: now + bounded * 1000 });
  return true;
}

// Drops everything already past its window. Called opportunistically rather
// than on a timer: an expired entry is already inert to readCached, so this
// only reclaims memory and never changes an answer.
export function pruneCache(cache, now) {
  if (!cache) return 0;
  let dropped = 0;
  for (const [key, entry] of cache.entries) {
    if (entry.expires <= now) {
      cache.entries.delete(key);
      dropped += 1;
    }
  }
  return dropped;
}

export function cachedEntryCount(cache) {
  return cache?.entries?.size ?? 0;
}

export function cacheStats(cache) {
  const hits = cache?.hits ?? 0;
  const misses = cache?.misses ?? 0;
  const total = hits + misses;
  return { hits, misses, evictions: cache?.evictions ?? 0, hitRate: total ? hits / total : null };
}
