import assert from "node:assert/strict";
import test from "node:test";

import { updatedLabel } from "../src/format.js";
import { buildModel } from "../src/data.js";

// The bug these guard: the header's "updated" chip reported how long ago WE
// fetched, and nothing else. When the Worker is serving its own last-known-good
// copy because upstream is failing (src/liveStale.js) we really did just fetch,
// and what came back was old, so the chip said "just now" over a frozen
// scoreline. That is the most confident possible way to be wrong, and it is why
// "live updates were not happening" was invisible from inside the app.

const NOW = 1_700_000_000_000;

test("with no fetch yet the chip is loading, not an age", () => {
  assert.deepEqual(updatedLabel({ fetchedAt: 0, now: NOW }), { text: "loading", delayed: false });
  assert.deepEqual(updatedLabel({}), { text: "loading", delayed: false });
});

test("a healthy feed reports the age of our own fetch", () => {
  assert.equal(updatedLabel({ fetchedAt: NOW - 2_000, now: NOW }).text, "just now");
  assert.equal(updatedLabel({ fetchedAt: NOW - 30_000, now: NOW }).text, "30s ago");
  assert.equal(updatedLabel({ fetchedAt: NOW - 5 * 60_000, now: NOW }).text, "5m ago");
  assert.equal(updatedLabel({ fetchedAt: NOW - 30_000, now: NOW }).delayed, false);
});

test("a stale feed reports the DATA's age, not the fetch's, and says so", () => {
  // Fetched two seconds ago; what came back was already fourteen minutes old.
  // The old chip said "just now" here, which is the whole defect.
  const label = updatedLabel({ fetchedAt: NOW - 2_000, now: NOW, staleAgeMs: 14 * 60_000 });
  assert.equal(label.delayed, true);
  assert.match(label.text, /14m ago/);
  assert.match(label.text, /delayed/);
});

test("the reported age adds our fetch age to the staleness the Worker measured", () => {
  // Both have elapsed since the data was actually current, so the honest age is
  // the sum: a 9-minute-stale payload fetched 90s ago is 10.5 minutes old.
  const label = updatedLabel({ fetchedAt: NOW - 90_000, now: NOW, staleAgeMs: 9 * 60_000 });
  assert.match(label.text, /10m ago/);
});

test("phrasing reads correctly after the static \"Updated\" label", () => {
  // App.svelte renders `Updated <time>`, so the text must not start with "delayed"
  // or the chip reads "Updated delayed 14m ago".
  const label = updatedLabel({ fetchedAt: NOW - 2_000, now: NOW, staleAgeMs: 14 * 60_000 });
  assert.equal(`Updated ${label.text}`, "Updated 14m ago (delayed)");
});

test("a zero staleness still counts as delayed", () => {
  // The Worker said it served a stale copy. Rounding its age to nothing does not
  // make the payload current, and `null` is the only value that means "fresh".
  assert.equal(updatedLabel({ fetchedAt: NOW, now: NOW, staleAgeMs: 0 }).delayed, true);
});

// -- the model passthrough ----------------------------------------------------

const raw = (extra = {}) => ({
  source: "API-Football",
  lastUpdated: "2026-08-21T18:00:00.000Z",
  competition: "PL",
  matches: [{ id: 1, utcDate: "2026-08-21T19:00:00.000Z", status: "IN_PLAY", score: {} }],
  standings: [],
  ...extra,
});

test("buildModel carries the Worker's stale marker onto the model", () => {
  const model = buildModel(raw({ stale: true, staleAgeMs: 90_000 }));
  assert.equal(model.hasData, true);
  assert.equal(model.stale, true);
  assert.equal(model.staleAgeMs, 90_000);
});

test("a healthy or static response is not delayed, and its age is null not zero", () => {
  // null is what updatedLabel reads as "nothing is delayed"; 0 would render as
  // delayed by no time at all, which is a different and untrue claim.
  const model = buildModel(raw());
  assert.equal(model.stale, false);
  assert.equal(model.staleAgeMs, null);
});

test("a stale marker with no age is still stale", () => {
  const model = buildModel(raw({ stale: true }));
  assert.equal(model.stale, true);
  assert.equal(model.staleAgeMs, 0);
});

test("the marker survives the no-data branch too", () => {
  // An empty feed is exactly when a reader most needs to know whether they are
  // looking at "nothing on today" or "we cannot see the feed".
  const model = buildModel({ ...raw(), matches: [], standings: [], stale: true, staleAgeMs: 60_000 });
  assert.equal(model.hasData, false);
  assert.equal(model.stale, true);
  assert.equal(model.staleAgeMs, 60_000);
});
