import assert from "node:assert/strict";
import test from "node:test";
import { createStoredDetailReader } from "../worker/stored-detail.js";
import { scoreFeed } from "../services/scores/snapshots.mjs";
import { isSettleableDetail } from "../src/fantasyScoring.js";
import worker from "../worker/worker.js";

const at = Date.now(), comp = { code: "CL", season: "2026" }, origin = "https://detail-reader.invalid";
function detail() {
  return { id: 900001, source: "stored-score-service", competition: "CL", season: "2026", status: "IN_PLAY",
    utcDate: new Date(at - 1800000).toISOString(), minute: 30, score: { home: 1, away: 0 },
    home: { name: "Home", lineup: [{ id: 1 }], bench: [] }, away: { name: "Away", lineup: [{ id: 2 }], bench: [] },
    goals: [], cards: [], subs: [], playerStats: [], degraded: [], stale: false,
    coverage: Object.fromEntries(["fixture", "lineups", "events", "players"].map(name => [name, { state: "complete", observedAt: at, ageMs: 0 }])),
    snapshot: { version: 1, collectorEpoch: 1, observedAt: at, detailVersion: 4, detailCollectorEpoch: 1 } };
}

test("detail reads coalesce without retaining a polling TTL or leaking provider credentials", async () => {
  let count = 0;
  const reader = createStoredDetailReader({ now: () => at, fetcher: async (url, options) => {
    count++; assert.equal(url, origin + "/CL/match/900001"); assert.deepEqual(options.headers, { Accept: "application/json" });
    assert.equal(options.redirect, "error"); return Response.json(detail());
  } });
  const [a, b] = await Promise.all([reader(comp, 900001, origin), reader(comp, 900001, origin)]);
  assert.equal(count, 1); a.home.lineup[0].id = 99; assert.equal(b.home.lineup[0].id, 1);
  await reader(comp, 900001, origin); assert.equal(count, 2);
});

test("failed refresh retains source time and blocks settlement even before the freshness deadline", async () => {
  let failed = false, clock = at;
  const reader = createStoredDetailReader({ now: () => clock, fetcher: async () => {
    if (failed) throw Error("offline"); return Response.json(detail());
  } });
  await reader(comp, 900001, origin); failed = true; clock += 1000;
  const result = await reader(comp, 900001, origin);
  assert.equal(result.coverage.events.observedAt, at); assert.equal(result.coverage.events.ageMs, 1000);
  assert.equal(result.degraded.length, 4); assert.equal(isSettleableDetail(result), false);
  await assert.rejects(reader(comp, 900002, origin));
  await assert.rejects(reader({ ...comp, season: "2027" }, 900001, origin));
  await assert.rejects(reader(comp, 900001, "https://different.invalid"));
});

test("section age is recomputed independently and partial data remains partial", async () => {
  const body = detail(); body.coverage.players.state = "partial";
  const reader = createStoredDetailReader({ now: () => at + 61000, fetcher: async () => Response.json(body) });
  const result = await reader(comp, 900001, origin);
  assert.equal(result.coverage.events.state, "stale"); assert.equal(result.coverage.lineups.state, "complete");
  assert.equal(result.coverage.players.state, "partial"); assert.equal(result.stale, true);
});

test("score and detail versions cannot regress but later downward corrections are accepted", async () => {
  let body = detail();
  const reader = createStoredDetailReader({ now: () => at, fetcher: async () => Response.json(body) });
  await reader(comp, 900001, origin);
  body.snapshot.version++; body.snapshot.detailVersion++; body.score.home = 0;
  assert.equal((await reader(comp, 900001, origin)).score.home, 0);
  body.snapshot.detailVersion--;
  const retained = await reader(comp, 900001, origin);
  assert.equal(retained.snapshot.detailVersion, 5); assert.equal(retained.stale, true);
});

test("malformed identities, coverage, scores and oversized bodies are rejected on cold reads", async () => {
  for (const change of [b => { b.id++; }, b => { b.season = "2025"; }, b => { b.coverage.events = {}; },
    b => { b.snapshot.observedAt += 5000; }, b => { b.score.home = null; }, b => { b.home.lineup = null; },
    b => { b.snapshot.detailVersion = null; }, b => { b.status = "UNKNOWN"; }]) {
    const body = detail(); change(body);
    const reader = createStoredDetailReader({ now: () => at, fetcher: async () => Response.json(body) });
    await assert.rejects(reader(comp, 900001, origin));
  }
  const reader = createStoredDetailReader({ fetcher: async () => new Response("x".repeat(1024 * 1024 + 1)) });
  await assert.rejects(reader(comp, 900001, origin), /exceeds/);
});

test("public Worker detail reads stay on stored service and never replace degraded data with legacy KV", async t => {
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  let failed = false, storedCalls = 0, legacyReads = 0;
  const match = { id: 900001, utcDate: detail().utcDate, status: "IN_PLAY", homeTeam: "Home", awayTeam: "Away", score: { home: 1, away: 0 } };
  globalThis.fetch = async url => {
    assert.ok(String(url).startsWith(origin), `Unexpected provider call: ${url}`);
    storedCalls++;
    if (String(url).endsWith("/live")) return Response.json(scoreFeed({ competition: "CL", season: "2026", version: 1, collectorEpoch: 1,
      publishedAt: at, scheduleObservedAt: at, fixtures: [{ match, observedAt: at }], standings: { rows: [], observedAt: null, delayed: true } }, at));
    return failed ? new Response("offline", { status: 503 }) : Response.json(detail());
  };
  const env = { API_FOOTBALL_KEY: "not-for-forwarding", API_FOOTBALL_COMPETITIONS: "CL:2026", SCORE_READ_ORIGIN: origin,
    ANALYSIS_CACHE: { get: async () => { legacyReads++; return null; }, put: async () => { throw Error("Legacy write"); } } };
  const request = () => worker.fetch(new Request("https://worker.invalid/match/900001", { headers: { Origin: "https://kickoffdraft.com" } }), env, { waitUntil() {} });
  const first = await request(); assert.equal(first.status, 200); assert.equal(first.headers.get("Cache-Control"), "no-store");
  failed = true;
  const second = await request(), body = await second.json();
  assert.equal(second.status, 200); assert.equal(body.degraded.length, 4); assert.equal(isSettleableDetail(body), false);
  assert.equal(legacyReads, 0); assert.equal(storedCalls, 4);
});
