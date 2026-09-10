import assert from "node:assert/strict";
import test from "node:test";
import { buildModel, loadModel, modelSignature } from "../src/data.js";
import { updatedLabel } from "../src/format.js";

const feed = {
  competition: "CL", source: "API-Football", lastUpdated: "2026-09-10T19:00:00Z",
  matches: [{ id: 1, status: "IN_PLAY", stage: "LEAGUE_STAGE", homeTeam: "Home", awayTeam: "Away", score: { home: 1, away: 0 } }],
  standings: [],
};

test("an old live payload is delayed even when the server responds successfully", t => {
  const now = Date.parse("2026-09-10T19:15:00Z");
  t.mock.method(Date, "now", () => now);
  const model = buildModel(feed);
  assert.equal(model.stale, true);
  assert.equal(model.staleAgeMs, 900000);
  assert.match(updatedLabel({ fetchedAt: now, now, updatedAt: Date.parse(feed.lastUpdated), stale: model.stale }).text, /15m ago.*delayed/);
});

test("healthy feed age is based on its timestamp rather than its latest download", () => {
  const now = Date.parse("2026-09-10T19:01:00Z");
  assert.equal(updatedLabel({ fetchedAt: now, now, updatedAt: now - 30000 }).text, "30s ago");
});

test("a static fallback reports the saved data's age instead of the successful download time", async t => {
  t.mock.method(Date, "now", () => Date.parse("2026-09-10T19:15:00Z"));
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.ok(options.signal instanceof AbortSignal, "feed requests must have a deadline");
    if (url.includes("scorers.json")) return Response.json({ scorers: [] });
    if (url.startsWith("https://")) return new Response("Unavailable", { status: 503 });
    return Response.json(feed);
  });
  const model = await loadModel("CL");
  assert.equal(model.hasData, true);
  assert.equal(model.stale, true);
  assert.equal(model.staleAgeMs, 15 * 60000);
});

test("fallback data without a timestamp keeps its age unknown", async t => {
  t.mock.method(globalThis, "fetch", async url => {
    if (url.includes("scorers.json")) return Response.json({});
    if (url.startsWith("https://")) throw new Error("offline");
    return Response.json({ ...feed, lastUpdated: "" });
  });
  const model = await loadModel("CL");
  assert.equal(model.stale, true);
  assert.equal(model.staleAgeMs, null);
});

test("a healthy empty season differs from two unavailable delivery paths", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ ...feed, matches: [] }));
  const empty = await loadModel("CL");
  assert.equal(empty.hasData, false);
  assert.equal(empty.error, undefined);
  fetch.mock.mockImplementation(async () => new Response("Unavailable", { status: 503 }));
  const unavailable = await loadModel("CL");
  assert.equal(unavailable.hasData, false);
  assert.match(unavailable.error, /not available/);
});

test("refresh detects table and delay changes even when every score is unchanged", () => {
  const model = { competition: { code: "CL" }, hasData: true, matches: feed.matches, tables: [{ rows: [{ points: 3 }] }], stale: false };
  assert.notEqual(modelSignature(model), modelSignature({ ...model, tables: [{ rows: [{ points: 6 }] }] }));
  assert.notEqual(modelSignature(model), modelSignature({ ...model, stale: true }));
  assert.equal(modelSignature(model), modelSignature({ ...model, lastUpdated: "later", staleAgeMs: 5000 }));
});
