import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CACHE_ENTRIES,
  MAX_STALE_GRACE_MS,
  MAX_TTL_SECONDS,
  classifyColoEntry,
  cacheStats,
  cachedEntryCount,
  createResponseCache,
  pruneCache,
  readCached,
  writeCached,
} from "../src/apiCache.js";

test("a stored payload is served for exactly the window it was given", () => {
  const cache = createResponseCache();
  writeCached(cache, "/fixtures", { response: [1] }, 60, 1000);

  assert.deepEqual(readCached(cache, "/fixtures", 1000), { response: [1] });
  assert.deepEqual(readCached(cache, "/fixtures", 60_999), { response: [1] });
  // The boundary is exclusive: at exactly the expiry the entry is gone. This is
  // the whole safety property, since the window is the one the call site
  // already declared to Cloudflare via cf.cacheTtl.
  assert.equal(readCached(cache, "/fixtures", 61_000), undefined);
});

test("a miss and a stored null are distinguishable", () => {
  const cache = createResponseCache();
  writeCached(cache, "/standings", null, 60, 0);
  assert.equal(readCached(cache, "/standings", 0), null);
  assert.equal(readCached(cache, "/nothing-here", 0), undefined);
});

test("an expired entry is dropped rather than left to accumulate", () => {
  const cache = createResponseCache();
  writeCached(cache, "/a", 1, 10, 0);
  assert.equal(cachedEntryCount(cache), 1);
  readCached(cache, "/a", 20_000);
  assert.equal(cachedEntryCount(cache), 0);
});

test("a non-positive or unparseable ttl stores nothing at all", () => {
  const cache = createResponseCache();
  // A call site that declined to declare a window is asking for a fresh read,
  // and inventing one here would silently change what it means.
  for (const ttl of [0, -5, undefined, null, NaN, "soon"]) {
    assert.equal(writeCached(cache, `/k${String(ttl)}`, 1, ttl, 0), false);
  }
  assert.equal(cachedEntryCount(cache), 0);
});

test("a ttl beyond the longest declared window is clamped, not trusted", () => {
  const cache = createResponseCache();
  writeCached(cache, "/forever", 1, 365 * 24 * 3600, 0);
  assert.equal(readCached(cache, "/forever", MAX_TTL_SECONDS * 1000 - 1), 1);
  assert.equal(readCached(cache, "/forever", MAX_TTL_SECONDS * 1000), undefined);
});

test("the cache is bounded, and evicts the least recently used", () => {
  const cache = createResponseCache();
  for (let i = 0; i < MAX_CACHE_ENTRIES; i += 1) writeCached(cache, `/k${i}`, i, 600, 0);
  assert.equal(cachedEntryCount(cache), MAX_CACHE_ENTRIES);

  // Touch the oldest so it is no longer the eviction candidate. Without the
  // re-insert in readCached, a URL fetched once at isolate start would be the
  // first thing dropped no matter how hot it is.
  readCached(cache, "/k0", 0);
  writeCached(cache, "/new", "x", 600, 0);

  assert.equal(cachedEntryCount(cache), MAX_CACHE_ENTRIES);
  assert.equal(readCached(cache, "/k0", 0), 0, "the recently used entry was evicted");
  assert.equal(readCached(cache, "/k1", 0), undefined, "the least recently used entry survived");
});

test("re-writing a key replaces it rather than growing the cache", () => {
  const cache = createResponseCache();
  writeCached(cache, "/a", 1, 60, 0);
  writeCached(cache, "/a", 2, 60, 0);
  assert.equal(cachedEntryCount(cache), 1);
  assert.equal(readCached(cache, "/a", 0), 2);
});

test("pruning drops only what has already expired", () => {
  const cache = createResponseCache();
  writeCached(cache, "/short", 1, 10, 0);
  writeCached(cache, "/long", 2, 6 * 3600, 0);
  assert.equal(pruneCache(cache, 20_000), 1);
  assert.equal(readCached(cache, "/long", 20_000), 2);
});

test("stats separate hits from misses so a regression is visible", () => {
  const cache = createResponseCache();
  writeCached(cache, "/a", 1, 60, 0);
  readCached(cache, "/a", 0);
  readCached(cache, "/a", 0);
  readCached(cache, "/b", 0);
  assert.deepEqual(cacheStats(cache), { hits: 2, misses: 1, evictions: 0, hitRate: 2 / 3 });
});

test("a null cache is inert rather than a crash", () => {
  // Measurement and caching must never be able to break the thing they wrap.
  assert.equal(readCached(null, "/a", 0), undefined);
  assert.equal(writeCached(null, "/a", 1, 60, 0), false);
  assert.equal(pruneCache(null, 0), 0);
  assert.equal(cachedEntryCount(null), 0);
  assert.equal(cacheStats(null).hitRate, null);
});

// -- the colo cache's freshness policy -----------------------------------------
// Same guarantee as the memo (fresh means inside the caller's own declared
// ttl), plus a bounded "stale" band served only as a fallback when a live
// upstream read just failed.

test("a colo entry is fresh inside the declared ttl and expired past it with no grace", () => {
  assert.equal(classifyColoEntry({ storedAt: 0, now: 59_000, ttlMs: 60_000 }), "fresh");
  assert.equal(classifyColoEntry({ storedAt: 0, now: 60_000, ttlMs: 60_000 }), "fresh");
  assert.equal(classifyColoEntry({ storedAt: 0, now: 60_001, ttlMs: 60_000 }), "expired");
});

test("grace opens a stale band after the ttl, and only after it", () => {
  const graceMs = 10 * 60 * 1000;
  assert.equal(classifyColoEntry({ storedAt: 0, now: 61_000, ttlMs: 60_000, graceMs }), "stale");
  assert.equal(classifyColoEntry({ storedAt: 0, now: 60_000 + graceMs, ttlMs: 60_000, graceMs }), "stale");
  assert.equal(classifyColoEntry({ storedAt: 0, now: 60_001 + graceMs, ttlMs: 60_000, graceMs }), "expired");
});

test("grace is clamped to the maximum, so no call site can serve arbitrarily old data", () => {
  const huge = 24 * 60 * 60 * 1000;
  assert.equal(
    classifyColoEntry({ storedAt: 0, now: 60_000 + MAX_STALE_GRACE_MS, ttlMs: 60_000, graceMs: huge }),
    "stale",
  );
  assert.equal(
    classifyColoEntry({ storedAt: 0, now: 60_001 + MAX_STALE_GRACE_MS, ttlMs: 60_000, graceMs: huge }),
    "expired",
  );
});

test("garbage in means expired, never a confident answer", () => {
  assert.equal(classifyColoEntry({ storedAt: NaN, now: 0, ttlMs: 60_000 }), "expired");
  assert.equal(classifyColoEntry({ storedAt: "not a time", now: 0, ttlMs: 60_000 }), "expired");
  assert.equal(classifyColoEntry({ storedAt: 0, now: 1000, ttlMs: 0 }), "expired");
  assert.equal(classifyColoEntry({ storedAt: 0, now: 1000, ttlMs: -5 }), "expired");
  // a stored-at in the future means a clock ran backwards; not evidence of freshness
  assert.equal(classifyColoEntry({ storedAt: 5000, now: 1000, ttlMs: 60_000 }), "expired");
});
