import assert from "node:assert/strict";
import test from "node:test";

import { LIVE_STALE_GRACE_MS, markStaleLive, tooStaleForBrowser } from "../src/liveStale.js";

// The bug this guards: the Worker's stale-on-error fallback held the last good
// /live body in isolate memory with no timestamp and no expiry, so a sustained
// upstream failure was served as a 200 with a frozen `lastUpdated` for as long as
// the isolate lived. Because src/data.js only falls back to the static bake when
// the Worker does not answer 200, that stale 200 suppressed the very fallback
// written for this case, and the site looked alive while never changing again.

const body = () => ({
  source: "API-Football",
  lastUpdated: "2026-08-21T18:00:00.000Z",
  competition: "PL",
  season: "2026",
  matches: [{ id: 1, status: "IN_PLAY" }],
  standings: [{ table: [] }],
});

test("no entry means no fallback, so getLive rethrows", () => {
  assert.equal(markStaleLive(undefined), null);
  assert.equal(markStaleLive(null), null);
  // A cold isolate that has never had a success holds no body.
  assert.equal(markStaleLive({ storedAt: 0 }), null);
});

test("a stale body is marked and carries its age", () => {
  const now = 10_000_000;
  const served = markStaleLive({ body: body(), storedAt: now - 20_000 }, now);
  assert.equal(served.stale, true);
  assert.equal(served.staleAgeMs, 20_000);
  // Otherwise untouched: lastUpdated keeps telling the truth about when the data
  // was actually current, rather than being refreshed to now.
  assert.equal(served.lastUpdated, "2026-08-21T18:00:00.000Z");
  assert.deepEqual(served.matches, body().matches);
});

test("marking never mutates the stored entry", () => {
  // The entry is the isolate's only record of the last good response. Annotating
  // it in place would leak one request's marker into the next.
  const entry = { body: body(), storedAt: 0 };
  markStaleLive(entry, 1000);
  assert.equal("stale" in entry.body, false);
  assert.equal("staleAgeMs" in entry.body, false);
});

test("age is clamped when the clock moves backwards", () => {
  const served = markStaleLive({ body: body(), storedAt: 5000 }, 4000);
  assert.equal(served.stale, true);
  assert.equal(served.staleAgeMs, 0);
});

// -- the browser-facing bound -------------------------------------------------
// Applied at the route only. getLive's other callers are the cron passes, which
// read the season schedule and are better served by a stale copy than by nothing.

test("a fresh body is always servable to the browser", () => {
  assert.equal(tooStaleForBrowser(body()), false);
  // Belt and braces: a body with no stale marker at all, whatever else it holds.
  assert.equal(tooStaleForBrowser({ ...body(), staleAgeMs: 99 * 60 * 1000 }), false);
});

test("a stale body inside the grace window is servable", () => {
  assert.equal(tooStaleForBrowser({ ...body(), stale: true, staleAgeMs: 0 }), false);
  assert.equal(tooStaleForBrowser({ ...body(), stale: true, staleAgeMs: 30_000 }), false);
  assert.equal(tooStaleForBrowser({ ...body(), stale: true, staleAgeMs: LIVE_STALE_GRACE_MS }), false);
});

test("a stale body past the grace window is refused, so the browser gets the static bake", () => {
  assert.equal(
    tooStaleForBrowser({ ...body(), stale: true, staleAgeMs: LIVE_STALE_GRACE_MS + 1 }),
    true,
  );
  // The case that was actually happening: hours of upstream failure, warm isolate.
  assert.equal(
    tooStaleForBrowser({ ...body(), stale: true, staleAgeMs: 6 * 60 * 60 * 1000 }),
    true,
  );
});

test("a missing age on a stale body is treated as servable, not as expired", () => {
  // Fail open: a marker without an age is a bug in the marker, and blanking the
  // feed for every reader is a worse answer to it than serving what we have.
  assert.equal(tooStaleForBrowser({ ...body(), stale: true }), false);
});

test("the grace window stays shorter than the static bake's own hourly cadence", () => {
  // Past the window we hand over to data/<comp>/live.json, which the Pages Action
  // refreshes hourly. A grace longer than that cadence would keep preferring a
  // copy that is provably older than the file we would fall back to.
  assert.ok(LIVE_STALE_GRACE_MS < 60 * 60 * 1000);
});
