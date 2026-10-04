import assert from "node:assert/strict";
import test from "node:test";
import { loadModel } from "../src/data.js";
import { retainNewestScores } from "../src/scoreSnapshot.js";
import { nextSnapshot, scoreFeed } from "../services/scores/snapshots.mjs";

const now = Date.parse("2026-09-10T21:10:00Z");
const final = { competition: "CL", lastUpdated: "2026-09-10T21:09:00Z", standings: [],
  matches: [{ id: 1, homeTeam: "Home", awayTeam: "Away", status: "FINISHED", score: { home: 4, away: 0 } }] };
function storage(t) {
  const data = new Map();
  t.mock.method(Date, "now", () => now);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "localStorage", previous); else delete globalThis.localStorage; });
  return data;
}

test("reload with an older static fallback retains the final score and its original age", async t => {
  storage(t);
  let offline = false;
  t.mock.method(globalThis, "fetch", async url => {
    if (url.includes("scorers")) return Response.json({});
    if (url.startsWith("https:")) return offline ? new Response("offline", { status: 503 }) : Response.json(final);
    return Response.json({ ...final, lastUpdated: "2026-09-10T19:16:00Z", matches: [{ ...final.matches[0], status: "TIMED", score: {} }] });
  });
  assert.equal((await loadModel("CL")).matches[0].status, "FINISHED");
  offline = true;
  const reloaded = await loadModel("CL");
  assert.equal(reloaded.matches[0].score.home, 4);
  assert.equal(reloaded.matches[0].status, "FINISHED");
  assert.equal(reloaded.lastUpdated, final.lastUpdated);
  assert.equal(reloaded.staleAgeMs, 60000);
  assert.equal(reloaded.stale, true);
});

test("a newer provider correction can lower a score and clear delayed status", t => {
  storage(t);
  retainNewestScores(final, "CL");
  const corrected = { ...final, lastUpdated: "2026-09-10T21:10:00Z", matches: [{ ...final.matches[0], score: { home: 3, away: 0 } }] };
  assert.equal(retainNewestScores(corrected, "CL"), corrected);
});

test("total outage or an empty response retains saved scores without crossing competitions", t => {
  storage(t);
  retainNewestScores(final, "CL");
  assert.equal(retainNewestScores({ error: "offline" }, "CL").matches[0].score.home, 4);
  assert.equal(retainNewestScores({ ...final, matches: [] }, "CL").matches[0].status, "FINISHED");
  assert.deepEqual(retainNewestScores({ error: "offline" }, "PL"), { error: "offline" });
});

test("expired, future-dated and corrupt local snapshots cannot hide the current feed", t => {
  const data = storage(t);
  for (const saved of ["broken", JSON.stringify({ ...final, lastUpdated: "2026-09-08T21:09Z" }),
    JSON.stringify({ ...final, lastUpdated: "2027-01-01T00:00Z" }), JSON.stringify({ ...final, competition: "PL" })]) {
    data.set("gs-score-snapshot-CL", saved);
    assert.equal(retainNewestScores(final, "CL"), final);
  }
});

test("blocked storage cannot prevent live scores loading", t => {
  storage(t);
  globalThis.localStorage = { getItem() { throw Error("blocked"); }, setItem() { throw Error("quota"); } };
  assert.equal(retainNewestScores(final, "CL"), final);
});

function stored(version, score, secondObservedAt = now) {
  const fixtures = [1, 2].map(id => ({ observedAt: id === 2 ? secondObservedAt : now,
    match: { id, utcDate: new Date(now - 1800000).toISOString(), status: "IN_PLAY", homeTeam: `Home ${id}`, awayTeam: `Away ${id}`, score: { home: score, away: 0 } } }));
  const snapshot = nextSnapshot(null, { competition: "CL", season: "2026", baseVersion: 0, fixtures, scheduleObservedAt: now }, { epoch: 1, now });
  return scoreFeed({ ...snapshot, version }, now);
}

test("a newer stored version preserves updated scores even when another game's older age lowers lastUpdated", t => {
  storage(t);
  retainNewestScores(stored(1, 1), "CL");
  const mixed = stored(2, 2, now - 120000);
  assert.equal(retainNewestScores(mixed, "CL"), mixed);
  assert.equal(mixed.staleAgeMs, 120000);
  const rolledBack = retainNewestScores(stored(1, 1), "CL");
  assert.equal(rolledBack.matches[0].score.home, 2);
  assert.equal(rolledBack.staleAgeMs, 120000);
});

test("an old unresolved fixture cannot discard newer observations for other games", t => {
  storage(t);
  retainNewestScores(stored(1, 1), "CL");
  const mixed = stored(2, 2, now - 2 * 86400000);
  assert.equal(retainNewestScores(mixed, "CL"), mixed);
  assert.equal(retainNewestScores({ error: "offline" }, "CL").matches[0].score.home, 2);
});

test("same-version offline recovery recomputes age when a scheduled match reaches kickoff", t => {
  const cache = storage(t);
  const feed = stored(1, 1);
  feed.matches[1].status = "TIMED";
  feed.matches[1].utcDate = new Date(now).toISOString();
  feed.snapshot.observations[1].observedAt = now - 300000;
  cache.set("gs-score-snapshot-CL", JSON.stringify(feed));
  assert.equal(retainNewestScores({ error: "offline" }, "CL").staleAgeMs, 300000);
});

test("corrupt stored-service metadata cannot break cache recovery", t => {
  storage(t);
  retainNewestScores(stored(1, 1), "CL");
  for (const corrupt of [feed => { feed.snapshot.observations = [null]; },
    feed => { feed.matches[0] = null; }, feed => { feed.snapshot.observations.pop(); }]) {
    const malformed = stored(2, 2);
    corrupt(malformed);
    assert.equal(retainNewestScores(malformed, "CL").matches[0].score.home, 1);
  }
});
