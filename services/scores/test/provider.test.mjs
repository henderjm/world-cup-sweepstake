import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { DynamoScoreStore } from "../dynamodb.mjs";
import { ScoreProvider } from "../provider.mjs";
import { createScoreReadApi } from "../snapshots.mjs";
import { mapApiFootballMatches } from "../../../src/mapApiFootball.js";
import { client, createTable, deleteTable } from "./support.mjs";

async function setup(t, handler, { initialize = true } = {}) {
  const db = client(), tableName = await createTable(db);
  let now = Date.parse("2026-10-04T12:00:00Z"), calls = 0;
  const clock = () => now;
  const store = new DynamoScoreStore({ client: db, tableName, now: clock });
  const server = createServer((req, res) => { calls++; handler(req, res); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    try { await deleteTable(db, tableName); } finally { db.destroy(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const transport = (url, options) => fetch(new URL(url.pathname + url.search, `http://127.0.0.1:${server.address().port}`), options);
  let lease = await store.claim("worker");
  if (initialize) await store.initializeBudget(lease, { dailyLimit: 10, minuteLimit: 300, scoreReserve: 3 }, 0);
  now += 60000;
  lease = await store.claim("worker");
  const provider = new ScoreProvider({ store, apiKey: "synthetic-local-key", fetch: transport, now: clock });
  return { db, tableName, store, clock, lease, provider, transport, calls: () => calls, advance: ms => { now += ms; } };
}

function healthy(req, res) {
  assert.equal(req.headers["x-apisports-key"], "synthetic-local-key");
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ errors: [], response: [{ fixture: { id: 900001 } }] }));
}

test("concurrent callers share admission and only one reaches the HTTP provider", async t => {
  const { store, provider, lease, calls, advance } = await setup(t, healthy);
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => provider.request(lease, "/fixtures?live=all")));
  assert.equal(results.filter(result => result.status === "fulfilled" && result.value.allowed).length, 1);
  assert.equal(calls(), 1);
  assert.equal((await store.readBudget()).used, 1);
  advance(201);
  assert.equal((await provider.request(lease, "/fixtures?live=all")).allowed, true);
  assert.equal(calls(), 2);
});

test("missing budget and external URLs cannot trigger a provider request", async t => {
  const { provider, lease, calls } = await setup(t, healthy, { initialize: false });
  await assert.rejects(provider.request(lease, "/fixtures"), /Missing budget/);
  await assert.rejects(provider.request(lease, "https://example.com/fixtures"), /Invalid provider path/);
  await assert.rejects(provider.request(lease, "//example.com/fixtures"), /Invalid provider path/);
  assert.equal(calls(), 0);
});

test("a lost admission reply costs quota but never sends an unconfirmed request", async t => {
  const { db, tableName, clock, lease, store, transport, calls, advance } = await setup(t, healthy);
  const uncertain = new DynamoScoreStore({ tableName, now: clock, client: { send: async (command, options) => {
    const result = await db.send(command, options);
    if (command.constructor.name === "TransactWriteItemsCommand") throw Error("Admission reply lost");
    return result;
  } } });
  const provider = new ScoreProvider({ store: uncertain, apiKey: "synthetic-local-key", fetch: transport, now: clock });
  await assert.rejects(provider.request(lease, "/fixtures"), /reply lost/);
  assert.equal(calls(), 0);
  assert.equal((await store.readBudget()).used, 1);
  advance(31000);
  const replacement = await store.claim("replacement");
  await assert.rejects(store.reserve(lease, "scores"), /expired/);
  const recovered = new ScoreProvider({ store, apiKey: "synthetic-local-key", fetch: transport, now: clock });
  assert.equal((await recovered.request(replacement, "/fixtures")).allowed, true);
  assert.equal((await store.readBudget()).used, 2);
  await assert.rejects(store.initializeBudget(replacement, { dailyLimit: 100, minuteLimit: 300, scoreReserve: 0 }, 0));
  assert.equal((await store.readBudget()).used, 2);
});

test("a delayed admission from a replaced collector cannot spend or fetch", async t => {
  const { db, tableName, clock, lease, store, transport, calls, advance } = await setup(t, healthy);
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const slow = new DynamoScoreStore({ tableName, now: clock, client: { send: async (command, options) => {
    if (command.constructor.name === "TransactWriteItemsCommand") { entered(); await gate; }
    return db.send(command, options);
  } } });
  const provider = new ScoreProvider({ store: slow, apiKey: "synthetic-local-key", fetch: transport, now: clock });
  const pending = provider.request(lease, "/fixtures");
  await ready;
  try { advance(31000); await store.claim("replacement"); } finally { release(); }
  await assert.rejects(pending, error => error.name === "TransactionCanceledException");
  assert.equal(calls(), 0);
  assert.equal((await store.readBudget()).used, 0);
});

test("an admitted request delayed past dispatch time is charged but not sent", async t => {
  const { store, clock, lease, transport, calls, advance } = await setup(t, healthy);
  const provider = new ScoreProvider({ apiKey: "synthetic-local-key", fetch: transport, now: clock, store: {
    reserve: async (...args) => { const result = await store.reserve(...args); advance(4000); return result; },
  } });
  await assert.rejects(provider.request(lease, "/fixtures"), /dispatch window/);
  assert.equal(calls(), 0);
  assert.equal((await store.readBudget()).used, 1);
});

test("a 200 quota error cools down all callers and survives a new adapter", async t => {
  const { db, tableName, store, clock, provider, lease, calls, advance } = await setup(t, (req, res) => {
    res.setHeader("Retry-After", "90");
    res.end(JSON.stringify({ errors: { requests: "quota exhausted" }, response: [] }));
  });
  await assert.rejects(provider.request(lease, "/fixtures"), /quota exhausted/);
  advance(31000);
  const restored = new DynamoScoreStore({ client: db, tableName, now: clock });
  const nextLease = await restored.claim("new-worker");
  assert.equal((await restored.reserve(nextLease, "scores")).reason, "paced");
  assert.equal((await store.readBudget()).used, 1);
  assert.equal(calls(), 1);
});

test("stalled response bodies abort within the request deadline and remain charged", async t => {
  const { store, provider, lease, calls } = await setup(t, (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"response":[');
  });
  const started = performance.now();
  await assert.rejects(provider.request(lease, "/fixtures"));
  assert.ok(performance.now() - started < 7000);
  const budget = await store.readBudget();
  assert.equal(budget.used, 1);
  assert.equal(budget.failures, 1);
  assert.equal(calls(), 1);
  assert.equal((await provider.request(lease, "/fixtures")).reason, "paced");
});

test("redirects do not forward the API key or create another unbudgeted request", async t => {
  const { store, provider, lease, calls } = await setup(t, (req, res) => {
    res.writeHead(302, { Location: "/destination" }); res.end();
  });
  await assert.rejects(provider.request(lease, "/fixtures"));
  assert.equal(calls(), 1);
  assert.equal((await store.readBudget()).used, 1);
});

test("malformed and oversized bodies fail without returning a successful observation", async t => {
  let oversized = false;
  const { store, provider, lease, calls, advance } = await setup(t, (req, res) => {
    res.end(oversized ? "x".repeat(8 * 1024 * 1024 + 1) : JSON.stringify({ response: null }));
  });
  await assert.rejects(provider.request(lease, "/fixtures"), /malformed response/);
  advance(1000); oversized = true;
  await assert.rejects(provider.request(lease, "/fixtures"), /size limit/);
  assert.equal((await store.readBudget()).used, 2);
  assert.equal(calls(), 2);
});

test("budgeted HTTP collection publishes real mapped scores and an outage retains their original age", async t => {
  let score = 1, outage = false;
  const { store, provider, lease, calls, clock, advance } = await setup(t, (req, res) => {
    if (outage) { res.writeHead(503); res.end("unavailable"); return; }
    res.end(JSON.stringify({ errors: [], response: [{
      fixture: { id: 900001, date: "2026-10-04T11:30:00Z", status: { short: "1H", elapsed: 30 } },
      league: { id: 2, season: 2026, round: "League Stage - 2" },
      teams: { home: { name: "Arsenal" }, away: { name: "Real Madrid" } },
      goals: { home: score, away: 0 },
    }] }));
  });
  for (const baseVersion of [0, 1]) {
    const result = await provider.request(lease, "/fixtures?league=2&season=2026", { priority: "scores" });
    await store.publish(lease, { competition: "CL", season: "2026", baseVersion,
      scheduleObservedAt: result.observedAt, fixtures: mapApiFootballMatches(result.payload)
        .map(match => ({ match, observedAt: result.observedAt, providerUpdatedAt: null })) });
    if (baseVersion === 0) { advance(15000); score = 2; }
  }
  advance(1000); outage = true;
  await assert.rejects(provider.request(lease, "/fixtures?league=2&season=2026", { priority: "scores" }));
  advance(45001);
  const api = createScoreReadApi({ readSnapshot: (code, season) => store.read(code, season), seasons: { CL: "2026" }, now: clock });
  const responses = await Promise.all(Array.from({ length: 100 }, () => api(new Request("https://scores.test/CL/live"))));
  assert.ok(responses.every(response => response.status === 200));
  const feed = await responses[0].json();
  assert.equal(feed.matches[0].score.home, 2);
  assert.equal(feed.snapshot.version, 2);
  assert.equal(feed.staleAgeMs, 46001);
  assert.equal(feed.stale, true);
  assert.equal(feed.snapshot.observations[0].providerUpdatedAt, null);
  assert.equal(calls(), 3);
  assert.equal((await store.readBudget()).used, 3);
});
