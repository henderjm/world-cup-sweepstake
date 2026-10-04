import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createStoredScoreReader } from "../worker/stored-scores.js";
import { scoreFeed } from "../services/scores/snapshots.mjs";
import worker from "../worker/worker.js";

const at = Date.now(), comp = { code: "PL", season: "2026" };
const origin = "https://scores.example.test";
const match = { id: 10, utcDate: new Date(at - 60000).toISOString(), status: "IN_PLAY",
  homeTeam: "Home", awayTeam: "Away", score: { home: 1, away: 0 } };
function feed({ code = "PL", version = 1, observedAt = at, matches = [match], season = "2026" } = {}) {
  return scoreFeed({ competition: code, season, version, collectorEpoch: 1, publishedAt: observedAt,
    scheduleObservedAt: observedAt, fixtures: matches.map(match => ({ match: structuredClone(match), observedAt })),
    standings: { rows: [], observedAt: null, delayed: true } }, observedAt);
}

test("stored reads preserve metadata, accept validated empty seasons and never transmit a provider key", async () => {
  const reader = createStoredScoreReader({ now: () => at, fetcher: async (url, options) => {
    assert.equal(url, origin + "/PL/live");
    assert.deepEqual(options.headers, { Accept: "application/json" });
    assert.equal(options.redirect, "error");
    return Response.json(feed({ matches: [] }));
  } });
  const body = await reader(comp, origin);
  assert.equal(body.snapshot.version, 1);
  assert.equal(body.matches.length, 0);
  assert.equal(body.stale, false);
});

test("newer versions allow downward score corrections; older versions and lost fixtures retain marked last-good data", async () => {
  let body = feed();
  const reader = createStoredScoreReader({ now: () => at, fetcher: async () => Response.json(body) });
  await reader(comp, origin);
  body = feed({ version: 2, matches: [{ ...match, score: { home: 0, away: 0 } }] });
  assert.equal((await reader(comp, origin)).matches[0].score.home, 0);
  body = feed();
  const saved = await reader(comp, origin);
  assert.equal(saved.snapshot.version, 2); assert.equal(saved.stale, true);
  body = feed({ version: 3, matches: [] });
  assert.equal((await reader(comp, origin)).matches.length, 1);
});

test("failure fallback ages from source observations, retains overdue fixtures and isolates seasons/origins", async () => {
  let clock = at, fail = false;
  const reader = createStoredScoreReader({ now: () => clock, fetcher: async () => {
    if (fail) throw Error("unavailable");
    return Response.json(feed());
  } });
  await reader(comp, origin); fail = true; clock += 120000;
  const body = await reader(comp, origin);
  assert.equal(body.staleAgeMs, 120000); assert.equal(body.snapshot.publishedAt, at);
  await assert.rejects(reader({ ...comp, season: "2027" }, origin));
  await assert.rejects(reader(comp, "https://other.example.test"));
  assert.equal((await reader(comp, origin)).snapshot.version, 1);
});

test("age is recomputed when a fixture becomes overdue without a new publication", async () => {
  let clock = at;
  const body = feed({ matches: [{ ...match, status: "TIMED", utcDate: new Date(at + 1000).toISOString() }] });
  const reader = createStoredScoreReader({ now: () => clock, fetcher: async () => Response.json(body) });
  assert.equal((await reader(comp, origin)).stale, false);
  clock += 60000;
  assert.equal((await reader(comp, origin)).stale, true);
});

test("cold readers reject malformed identities, missing observations and future source times", async () => {
  for (const change of [b => { b.competition = "CL"; }, b => { b.season = "2025"; },
    b => { b.snapshot.observations = []; }, b => { b.snapshot.publishedAt = at + 5000; },
    b => { b.snapshot.observations[0].observedAt = at + 5000; }, b => { b.matches[0].score.home = null; },
    b => { b.matches.push(b.matches[0]); b.snapshot.observations.push(b.snapshot.observations[0]); },
    b => { b.source = "API-Football"; }, b => { b.snapshot = null; }]) {
    const body = feed(); change(body);
    const reader = createStoredScoreReader({ now: () => at, fetcher: async () => Response.json(body) });
    await assert.rejects(reader(comp, origin));
  }
});

test("concurrent callers share one read without sharing mutable results or caching later polls", async () => {
  let calls = 0;
  const reader = createStoredScoreReader({ now: () => at, fetcher: async () => { calls++; return Response.json(feed()); } });
  const [a, b] = await Promise.all([reader(comp, origin), reader(comp, origin)]);
  assert.equal(calls, 1); a.matches[0].score.home = 99;
  assert.equal(b.matches[0].score.home, 1);
  await reader(comp, origin); assert.equal(calls, 2);
});

test("invalid configured origins fail before network and oversized responses are refused", async () => {
  let calls = 0;
  const reader = createStoredScoreReader({ fetcher: async () => { calls++; return new Response("x".repeat(4 * 1024 * 1024 + 1)); } });
  for (const value of ["https://secret@scores.example.test", "https://scores.example.test/path", "http://remote.test", "https://scores.example.test/?secret=1"])
    await assert.rejects(reader(comp, value));
  assert.equal(calls, 0);
  await assert.rejects(reader(comp, origin), /exceed/);
});

test("real HTTP body stalls hit the deadline", async t => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" }); res.write("{");
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const reader = createStoredScoreReader({ timeoutMs: 100 });
  await assert.rejects(reader(comp, `http://127.0.0.1:${server.address().port}`));
});

test("Worker score routes use only stored reads, recover in place and preserve the browser stale cutoff", async t => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
  let mode = "healthy", calls = 0;
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).startsWith(origin));
    assert.equal(options.headers["x-apisports-key"], undefined); calls++;
    if (mode === "failure") return new Response("unavailable", { status: 503 });
    const code = new URL(url).pathname.split("/")[1];
    return Response.json(feed({ code, version: mode === "recovery" ? 3 : mode === "old" ? 2 : 1,
      observedAt: mode === "old" ? at - 700000 : Date.now() }));
  };
  const env = { API_FOOTBALL_COMPETITIONS: "PL:2026,CL:2026", SCORE_READ_ORIGIN: origin };
  const request = path => worker.fetch(new Request("https://worker.example.test" + path, { headers: { Origin: "https://kickoffdraft.com" } }), env, { waitUntil() {} });
  for (const path of ["/live", "/PL/live", "/CL/live"]) {
    const response = await request(path); assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://kickoffdraft.com");
    assert.equal((await response.json()).source, "stored-score-service");
  }
  mode = "failure";
  assert.equal((await (await request("/PL/live")).json()).stale, true);
  mode = "old";
  assert.equal((await request("/PL/live")).status, 502);
  mode = "recovery";
  const recovered = await (await request("/PL/live")).json();
  assert.equal(recovered.snapshot.version, 3); assert.equal(recovered.stale, false);
  assert.equal(calls, 6);
});

test("missing configuration and invalid stored origins cannot trigger a direct-provider fallback", async t => {
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error("Unexpected network request"); };
  const request = env => worker.fetch(new Request("https://worker.example.test/PL/live", {
    headers: { Origin: "https://kickoffdraft.com" },
  }), { API_FOOTBALL_COMPETITIONS: "PL:2026", ...env }, { waitUntil() {} });
  assert.equal((await request({})).status, 500);
  assert.equal((await request({ SCORE_READ_ORIGIN: "http://untrusted.invalid", API_FOOTBALL_KEY: "must-not-fallback" })).status, 502);
  assert.equal(calls, 0);
});
