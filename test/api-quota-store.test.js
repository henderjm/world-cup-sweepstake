import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_BUFFER_KEYS,
  TIGHT_HEADROOM_FRACTION,
  bufferSize,
  bufferUsage,
  buildQuotaReport,
  chunkRows,
  createUsageBuffer,
  drainUsage,
  reportedUsage,
  usageDay,
} from "../src/apiQuotaStore.js";

const headers = (map) => ({
  get: (name) => {
    const key = Object.keys(map).find((k) => k.toLowerCase() === String(name).toLowerCase());
    return key === undefined ? null : map[key];
  },
});

const quotaHeaders = (remaining, limit = 150000) =>
  headers({
    "x-ratelimit-requests-limit": String(limit),
    "x-ratelimit-requests-remaining": String(remaining),
  });

const AT = "2026-07-28T12:00:00.000Z";

// -- the day key -------------------------------------------------------------

test("the quota day is UTC, so an evening call files under the provider's day", () => {
  // 23:30 in Dublin during summer is 22:30 UTC: the same day either way. The
  // case that matters is the other side of UTC midnight.
  assert.equal(usageDay("2026-07-28T23:30:00.000Z"), "2026-07-28");
  assert.equal(usageDay("2026-07-29T00:30:00.000Z"), "2026-07-29");
});

test("an unparseable instant yields no day rather than a wrong one", () => {
  assert.equal(usageDay("not a date"), null);
});

// -- buffering ---------------------------------------------------------------

test("repeat calls to one endpoint collapse into a single counted row", () => {
  const buffer = createUsageBuffer();
  for (let i = 0; i < 40; i += 1) {
    bufferUsage(buffer, { path: `/fixtures?id=${i}`, cacheStatus: "HIT", headers: headers({}), at: AT });
  }
  const { rows } = drainUsage(buffer);
  assert.equal(rows.length, 1, "a row per request would put a D1 write on the hot path");
  assert.deepEqual(rows[0], { day: "2026-07-28", endpoint: "/fixtures", upstream: false, count: 40 });
});

test("upstream and cached calls to the same endpoint stay separate rows", () => {
  const buffer = createUsageBuffer();
  bufferUsage(buffer, { path: "/fixtures?id=1", cacheStatus: "MISS", headers: quotaHeaders(100), at: AT });
  bufferUsage(buffer, { path: "/fixtures?id=1", cacheStatus: "HIT", headers: quotaHeaders(999), at: AT });
  const { rows } = drainUsage(buffer);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.upstream).count, 1);
  assert.equal(rows.find((row) => !row.upstream).count, 1);
});

test("a cache hit's replayed quota headers never move the remaining gauge", () => {
  const buffer = createUsageBuffer();
  bufferUsage(buffer, { path: "/fixtures", cacheStatus: "MISS", headers: quotaHeaders(1000), at: AT });
  // A cached response replays whatever remaining was stored with it. Believing
  // it would make the gauge jump backwards to a stale, higher figure.
  bufferUsage(buffer, { path: "/fixtures", cacheStatus: "HIT", headers: quotaHeaders(140000), at: AT });
  const { quota } = drainUsage(buffer);
  assert.equal(quota[0].dailyRemaining, 1000);
});

test("the lowest remaining seen in a day wins, so an out-of-order reading cannot refill the gauge", () => {
  const buffer = createUsageBuffer();
  bufferUsage(buffer, { path: "/fixtures", cacheStatus: "MISS", headers: quotaHeaders(900), at: AT });
  bufferUsage(buffer, { path: "/standings", cacheStatus: "MISS", headers: quotaHeaders(1200), at: AT });
  const { quota } = drainUsage(buffer);
  assert.equal(quota.length, 1);
  assert.equal(quota[0].dailyRemaining, 900);
});

test("calls either side of UTC midnight are filed under their own days", () => {
  const buffer = createUsageBuffer();
  bufferUsage(buffer, { path: "/fixtures", cacheStatus: "MISS", headers: headers({}), at: "2026-07-28T23:59:00Z" });
  bufferUsage(buffer, { path: "/fixtures", cacheStatus: "MISS", headers: headers({}), at: "2026-07-29T00:01:00Z" });
  const { rows } = drainUsage(buffer);
  assert.deepEqual(rows.map((row) => row.day).sort(), ["2026-07-28", "2026-07-29"]);
});

test("the buffer is bounded, so a path explosion degrades the chart instead of the isolate", () => {
  const buffer = createUsageBuffer();
  for (let i = 0; i < MAX_BUFFER_KEYS + 50; i += 1) {
    bufferUsage(buffer, { path: `/junk/${i}`, cacheStatus: "MISS", headers: headers({}), at: AT });
  }
  assert.equal(buffer.dropped, 50);
  const { rows } = drainUsage(buffer);
  assert.equal(rows.length, MAX_BUFFER_KEYS);
});

test("an already-counted key still increments once the cap is reached", () => {
  const buffer = createUsageBuffer();
  for (let i = 0; i < MAX_BUFFER_KEYS; i += 1) {
    bufferUsage(buffer, { path: `/junk/${i}`, cacheStatus: "MISS", headers: headers({}), at: AT });
  }
  bufferUsage(buffer, { path: "/junk/0", cacheStatus: "MISS", headers: headers({}), at: AT });
  assert.equal(buffer.dropped, 0, "an existing key is a counter bump, not a new allocation");
  assert.equal(bufferSize(buffer), MAX_BUFFER_KEYS + 1);
});

test("draining empties the buffer, so a flush that lands is never replayed", () => {
  const buffer = createUsageBuffer();
  bufferUsage(buffer, { path: "/fixtures", cacheStatus: "MISS", headers: quotaHeaders(10), at: AT });
  assert.equal(drainUsage(buffer).rows.length, 1);
  const second = drainUsage(buffer);
  assert.deepEqual(second, { rows: [], quota: [] });
  assert.equal(bufferSize(buffer), 0);
});

// -- D1 parameter chunking ---------------------------------------------------

test("rows are chunked under the 100 bound-parameter cap", () => {
  const rows = Array.from({ length: 70 }, (_, i) => i);
  const chunks = chunkRows(rows, 4);
  assert.ok(chunks.every((chunk) => chunk.length * 4 <= 100));
  assert.equal(chunks.flat().length, 70, "chunking must not drop a row");
});

test("a row binding more than the cap still yields one row per chunk rather than none", () => {
  const chunks = chunkRows([1, 2], 150);
  assert.deepEqual(chunks, [[1], [2]]);
});

// -- which "used" figure the projection trusts -------------------------------

test("the provider's own remaining count beats our counted calls", () => {
  // The same key is spent by the hourly Pages bake and the player-pool script,
  // neither of which passes through the Worker's fetchJson.
  assert.deepEqual(reportedUsage({ dailyLimit: 1000, dailyRemaining: 400 }, 250), {
    used: 600,
    source: "provider",
  });
});

test("with no provider figure the projection falls back to what we counted", () => {
  assert.deepEqual(reportedUsage(null, 250), { used: 250, source: "counted" });
  assert.deepEqual(reportedUsage({ dailyLimit: null, dailyRemaining: null }, 250), {
    used: 250,
    source: "counted",
  });
});

// -- the report --------------------------------------------------------------

const rows = [
  { endpoint: "/fixtures", upstream: true, count: 300 },
  { endpoint: "/fixtures", upstream: false, count: 2700 },
  { endpoint: "/standings", upstream: true, count: 100 },
];

test("the report leads on the cache hit rate and orders endpoints by what they spend", () => {
  const report = buildQuotaReport({ rows, quota: null, now: "2026-07-28T12:00:00Z" });
  assert.equal(report.upstreamCalls, 400);
  assert.equal(report.cachedCalls, 2700);
  assert.equal(report.totalCalls, 3100);
  assert.ok(Math.abs(report.cacheHitRate - 2700 / 3100) < 1e-9);
  assert.deepEqual(
    report.endpoints.map((entry) => entry.endpoint),
    ["/fixtures", "/standings"],
  );
});

test("a comfortable day reads ok, and the projection is halfway-through doubling", () => {
  const report = buildQuotaReport({
    rows,
    quota: { dailyLimit: 5000, dailyRemaining: 4600 },
    now: "2026-07-28T12:00:00Z",
  });
  assert.equal(report.quota.used, 400);
  assert.equal(report.quota.usedSource, "provider");
  assert.equal(report.projection.projected, 800);
  assert.equal(report.projection.willExceed, false);
  assert.equal(report.projection.verdict, "ok");
});

test("a day on course to breach reads over", () => {
  const report = buildQuotaReport({
    rows,
    quota: { dailyLimit: 500, dailyRemaining: 100 },
    now: "2026-07-28T12:00:00Z",
  });
  assert.equal(report.projection.willExceed, true);
  assert.equal(report.projection.verdict, "over");
});

test("a day projected to land just inside the ceiling reads tight rather than ok", () => {
  // Projected 800 against a 850 ceiling: 50 spare is under a tenth of the day's
  // allowance, which is the point at which the owner wants to know.
  const report = buildQuotaReport({
    rows,
    quota: { dailyLimit: 850, dailyRemaining: 450 },
    now: "2026-07-28T12:00:00Z",
  });
  assert.equal(report.projection.willExceed, false);
  assert.ok(report.projection.headroom < 850 * TIGHT_HEADROOM_FRACTION);
  assert.equal(report.projection.verdict, "tight");
});

test("with no known ceiling the verdict is unknown rather than a confident all-clear", () => {
  const report = buildQuotaReport({ rows, quota: null, now: "2026-07-28T12:00:00Z" });
  assert.equal(report.projection.willExceed, null);
  assert.equal(report.projection.verdict, "unknown");
  assert.equal(report.projection.projected, 800);
});

test("just after UTC midnight there is no projection at all, only the counts", () => {
  const report = buildQuotaReport({
    rows,
    quota: { dailyLimit: 5000, dailyRemaining: 4600 },
    now: "2026-07-28T00:02:00Z",
  });
  assert.equal(report.projection.projected, null);
  assert.equal(report.projection.verdict, "unknown");
  assert.equal(report.upstreamCalls, 400, "the counts are still real even when the projection is not");
});

test("a day with no recorded calls reports nulls instead of a fabricated 100% hit rate", () => {
  const report = buildQuotaReport({ rows: [], quota: null, now: "2026-07-28T12:00:00Z" });
  assert.equal(report.totalCalls, 0);
  assert.equal(report.cacheHitRate, null);
  assert.deepEqual(report.endpoints, []);
});
