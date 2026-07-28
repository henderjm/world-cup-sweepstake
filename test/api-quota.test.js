import test from "node:test";
import assert from "node:assert/strict";

import {
  MIN_ELAPSED_FRACTION_FOR_PROJECTION,
  endpointFamily,
  isUpstreamHit,
  parseQuotaHeaders,
  projectDailyUsage,
  summarizeUsage,
  usageRecord,
  utcDayFraction,
} from "../src/apiQuota.js";

// Minimal stand-in for the Headers interface, case-insensitive like the real one.
const headers = (map) => ({
  get: (name) => {
    const key = Object.keys(map).find((k) => k.toLowerCase() === String(name).toLowerCase());
    return key === undefined ? null : map[key];
  },
});

// -- what counts as spend ----------------------------------------------------

test("a cache hit is not upstream spend", () => {
  assert.equal(isUpstreamHit("HIT"), false);
  assert.equal(isUpstreamHit("hit"), false);
});

test("a miss, an expiry and an uncacheable response all cost a real call", () => {
  assert.equal(isUpstreamHit("MISS"), true);
  assert.equal(isUpstreamHit("EXPIRED"), true);
  assert.equal(isUpstreamHit("DYNAMIC"), true);
});

test("a missing cache-status header is treated as spend, so the budget errs conservative", () => {
  // Guessing "cached" here would silently under-report usage, which is the
  // dangerous direction: it hides a breach until the 429 arrives.
  assert.equal(isUpstreamHit(null), true);
  assert.equal(isUpstreamHit(undefined), true);
});

// -- endpoint families -------------------------------------------------------

test("endpointFamily drops the query so every fixture id does not become its own series", () => {
  assert.equal(endpointFamily("/fixtures?id=560542"), "/fixtures");
  assert.equal(endpointFamily("/fixtures?id=560543"), "/fixtures");
});

test("endpointFamily keeps distinct endpoints distinct", () => {
  assert.equal(endpointFamily("/fixtures/lineups?fixture=1"), "/fixtures/lineups");
  assert.notEqual(endpointFamily("/fixtures/events?fixture=1"), endpointFamily("/fixtures/lineups?fixture=1"));
});

test("endpointFamily normalises leading slash and trailing slash", () => {
  assert.equal(endpointFamily("players/squads?team=42"), "/players/squads");
  assert.equal(endpointFamily("/standings/"), "/standings");
});

test("endpointFamily never throws on junk", () => {
  assert.equal(endpointFamily(null), "unknown");
  assert.equal(endpointFamily(""), "unknown");
});

// -- quota headers -----------------------------------------------------------

test("parseQuotaHeaders reads the daily and per-minute allowances", () => {
  const quota = parseQuotaHeaders(
    headers({
      "x-ratelimit-requests-limit": "75000",
      "x-ratelimit-requests-remaining": "74120",
      "X-RateLimit-Limit": "450",
      "X-RateLimit-Remaining": "448",
    }),
  );
  assert.deepEqual(quota, { dailyLimit: 75000, dailyRemaining: 74120, minuteLimit: 450, minuteRemaining: 448 });
});

test("parseQuotaHeaders is case-insensitive, since the provider is inconsistent", () => {
  const quota = parseQuotaHeaders(headers({ "X-RATELIMIT-REQUESTS-REMAINING": "10" }));
  assert.equal(quota.dailyRemaining, 10);
});

test("parseQuotaHeaders returns null for a missing header, never zero", () => {
  // "we do not know" and "none left" must never look the same on a gauge.
  const quota = parseQuotaHeaders(headers({}));
  assert.equal(quota.dailyRemaining, null);
  assert.notEqual(quota.dailyRemaining, 0);
});

test("parseQuotaHeaders returns null for a non-numeric header rather than NaN", () => {
  assert.equal(parseQuotaHeaders(headers({ "x-ratelimit-requests-remaining": "lots" })).dailyRemaining, null);
});

// -- the record --------------------------------------------------------------

test("usageRecord marks a real upstream call as spend and keeps its quota reading", () => {
  const record = usageRecord({
    path: "/fixtures?id=1",
    cacheStatus: "MISS",
    headers: headers({ "x-ratelimit-requests-remaining": "500", "x-ratelimit-requests-limit": "75000" }),
    at: "2026-07-27T10:00:00Z",
  });
  assert.equal(record.endpoint, "/fixtures");
  assert.equal(record.upstream, true);
  assert.equal(record.dailyRemaining, 500);
  assert.equal(record.dailyLimit, 75000);
});

test("usageRecord discards a cached response's quota headers, because they are a stale replay", () => {
  // This is the whole reason the module exists. A HIT replays whatever
  // remaining was true when the entry was stored; recording it would make the
  // gauge jump backwards in time.
  const record = usageRecord({
    path: "/fixtures?id=1",
    cacheStatus: "HIT",
    headers: headers({ "x-ratelimit-requests-remaining": "74999" }),
    at: "2026-07-27T10:00:00Z",
  });
  assert.equal(record.upstream, false);
  assert.equal(record.dailyRemaining, null, "a cached reading must never be recorded as current");
});

// -- rollup ------------------------------------------------------------------

const rows = [
  { endpoint: "/fixtures", upstream: true, count: 20 },
  { endpoint: "/fixtures", upstream: false, count: 380 },
  { endpoint: "/fixtures/events", upstream: true, count: 60 },
  { endpoint: "/standings", upstream: true, count: 4 },
];

test("summarizeUsage separates real spend from cache-served demand", () => {
  const summary = summarizeUsage(rows);
  assert.equal(summary.upstreamCalls, 84);
  assert.equal(summary.cachedCalls, 380);
  assert.equal(summary.totalCalls, 464);
});

test("summarizeUsage reports the cache hit rate, the number actually worth watching", () => {
  const summary = summarizeUsage(rows);
  assert.equal(Math.round(summary.cacheHitRate * 100) / 100, 0.82);
});

test("summarizeUsage orders endpoints by what they spend, not by what is busiest", () => {
  // /fixtures has by far the most traffic but /fixtures/events costs more
  // upstream calls, and the dashboard's first question is where the money goes.
  const summary = summarizeUsage(rows);
  assert.equal(summary.endpoints[0].endpoint, "/fixtures/events");
});

test("summarizeUsage returns a null hit rate for no data rather than a misleading zero", () => {
  const summary = summarizeUsage([]);
  assert.equal(summary.cacheHitRate, null);
  assert.equal(summary.totalCalls, 0);
});

test("summarizeUsage treats a row with no explicit count as a single call", () => {
  assert.equal(summarizeUsage([{ endpoint: "/x", upstream: true }]).upstreamCalls, 1);
});

// -- projection --------------------------------------------------------------

test("projectDailyUsage extrapolates the day from what is spent so far", () => {
  const projection = projectDailyUsage({ used: 1000, elapsedFraction: 0.5, limit: 75000 });
  assert.equal(projection.projected, 2000);
  assert.equal(projection.willExceed, false);
  assert.equal(projection.headroom, 73000);
});

test("projectDailyUsage flags a day heading over the allowance", () => {
  const projection = projectDailyUsage({ used: 50000, elapsedFraction: 0.5, limit: 75000 });
  assert.equal(projection.projected, 100000);
  assert.equal(projection.willExceed, true);
  assert.ok(projection.headroom < 0);
});

test("projectDailyUsage refuses to extrapolate from the first moments of a day", () => {
  // Otherwise every midnight produces a false alarm off a handful of calls.
  assert.equal(projectDailyUsage({ used: 5, elapsedFraction: 0.0001, limit: 75000 }), null);
  assert.ok(MIN_ELAPSED_FRACTION_FOR_PROJECTION > 0);
});

test("projectDailyUsage reports an unknown verdict when no limit was supplied, rather than assuming one", () => {
  const projection = projectDailyUsage({ used: 1000, elapsedFraction: 0.5, limit: null });
  assert.equal(projection.projected, 2000);
  assert.equal(projection.willExceed, null, "a fabricated ceiling would produce a confident and wrong verdict");
});

test("projectDailyUsage rejects junk instead of returning NaN", () => {
  assert.equal(projectDailyUsage({ used: "x", elapsedFraction: 0.5, limit: 10 }), null);
  assert.equal(projectDailyUsage({ used: 10, elapsedFraction: 2, limit: 10 }), null);
});

// -- the quota day is UTC ----------------------------------------------------

test("utcDayFraction measures the day in UTC, matching when the provider resets", () => {
  assert.equal(utcDayFraction("2026-07-27T00:00:00Z"), 0);
  assert.equal(utcDayFraction("2026-07-27T12:00:00Z"), 0.5);
});

test("utcDayFraction ignores local timezone, so the dashboard cannot disagree with the provider about the date", () => {
  // Same instant, expressed with an offset. A local-midnight implementation
  // would report a different fraction here and misreport every evening.
  assert.equal(utcDayFraction("2026-07-27T12:00:00Z"), utcDayFraction("2026-07-27T14:00:00+02:00"));
});

test("utcDayFraction returns null on an unparseable date", () => {
  assert.equal(utcDayFraction("not a date"), null);
});
