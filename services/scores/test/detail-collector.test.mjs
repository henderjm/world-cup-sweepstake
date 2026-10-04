import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { detailJobs, validateDetailPayload } from "../detail-collector.mjs";
import { detailKey, detailSubject } from "../details.mjs";
import { ScoreCollector } from "../collector.mjs";
import { ScoreProvider } from "../provider.mjs";
import { DynamoScoreStore } from "../dynamodb.mjs";
import { detailCoverage } from "../details.mjs";
import { client, createTable, deleteTable } from "./support.mjs";

async function setup(t, limit = 1000) {
  const db = client(), tableName = await createTable(db);
  let now = Date.parse("2026-10-13T19:30:00Z") - 61000;
  const clock = () => now, calls = [];
  const store = new DynamoScoreStore({ client: db, tableName, now: clock });
  await store.initializeBudget(await store.claim("bootstrap"), { dailyLimit: limit, minuteLimit: 300, scoreReserve: 100 }, 0);
  now += 61000;
  const row = { fixture: { id: 900001, date: new Date(now - 1800000).toISOString(), status: { short: "1H", elapsed: 30 } },
    league: { id: 2, season: 2026, round: "League Stage - 2" },
    teams: { home: { id: 1, name: "Home" }, away: { id: 2, name: "Away" } }, goals: { home: 0, away: 0 } };
  const lineups = [1, 2].map(id => ({ team: { id }, startXI: Array.from({ length: 11 }, (_, n) =>
    ({ player: { id: id * 100 + n, name: `Player ${n}` } })), substitutes: [] }));
  const players = lineups.map(row => ({ team: row.team, players: row.startXI.map(entry => ({ ...entry,
    statistics: [{ games: { minutes: 30 }, tackles: { total: null } }] })) }));
  const state = { row, lineups, players, events: [], mutate: payload => payload };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost"); calls.push(url.pathname + url.search);
    let response = url.pathname === "/fixtures" ? [state.row]
      : url.pathname === "/standings" ? [] : state[url.pathname.split("/").at(-1)];
    const payload = state.mutate({ errors: [], results: response.length, paging: { current: 1, total: 1 }, response }, url);
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(payload));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    try { await deleteTable(db, tableName); } finally { db.destroy(); }
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const provider = new ScoreProvider({ store, apiKey: "localtest", now: clock,
    fetch: (url, options) => fetch(new URL(url.pathname + url.search, origin), options) });
  const collector = new ScoreCollector({ store, provider, seasons: { CL: 2026 }, owner: "collector", now: clock });
  const advance = ms => { now += ms; };
  const collect = async predicate => {
    for (let i = 0; i < 12; i++) { advance(1000); const result = await collector.step(); if (predicate(result)) return result; }
    throw Error("Expected collector action not reached");
  };
  return { collector, store, provider, clock, calls, state, advance, collect };
}

test("one detail request yields to due live scores and preserves raw unknown statistics", async t => {
  const { collector, collect, store, advance, state, calls } = await setup(t);
  await collect(result => result.kind === "detail" && result.section === "fixture" && result.state === "published");
  const before = calls.length;
  advance(16000); state.row.goals.home = 1;
  assert.equal((await collector.step()).kind, "live");
  assert.equal(calls.length, before + 1);
  assert.ok(calls.at(-1).startsWith("/fixtures?ids="));
  const published = await collect(result => result.section === "players" && result.state === "published");
  assert.equal(published.coverage, "complete");
  const detail = await store.readDetail("CL", "2026", 900001);
  assert.equal(detail.payloads.players.response[0].players[0].statistics[0].tackles.total, null);
  assert.equal(detail.sections.events.coverage, "partial"); // goal absent from timeline
  assert.equal((await store.readBudget()).used, calls.length);
});

test("supplementary detail cannot consume the score reserve", async t => {
  const { collector, collect, calls, advance, state, store } = await setup(t, 103);
  await collect(result => result.section === "fixture" && result.state === "published");
  const count = calls.length;
  assert.equal(count, 3); // discovery, unavailable standings, detail fixture
  advance(1000);
  const deferred = await collector.step();
  assert.equal(deferred.state, "deferred"); assert.equal(deferred.kind, "detail");
  assert.equal(calls.length, count);
  advance(16000); state.row.goals.home = 2;
  assert.equal((await collector.step()).kind, "live");
  assert.equal((await store.read("CL", "2026")).fixtures[0].match.score.home, 2);
});

test("partial refresh retains complete lineups and their original age", async t => {
  const { collector, collect, store, state, advance } = await setup(t);
  await collect(result => result.section === "lineups" && result.state === "published");
  const first = await store.readDetail("CL", "2026", 900001);
  state.lineups.pop(); advance(15 * 60000);
  const rejected = await collect(result => result.section === "lineups" && result.state === "failed");
  assert.equal(rejected.phase, "validation");
  const after = await store.readDetail("CL", "2026", 900001);
  assert.deepEqual(after.sections.lineups, first.sections.lineups);
  assert.deepEqual(after.payloads.lineups, first.payloads.lineups);
  assert.equal((await collector.step()).state, "idle");
});

test("takeover hydrates metadata without provider fanout and final whistle requires fresh sections", async t => {
  const { collector, collect, store, provider, state, clock, advance, calls } = await setup(t);
  await collect(result => result.section === "players" && result.state === "published");
  state.row.fixture.status.short = "FT"; advance(31000);
  const replacement = new ScoreCollector({ store, provider, seasons: { CL: 2026 }, owner: "replacement", now: clock });
  assert.equal((await replacement.step()).kind, "live");
  const finalMatch = (await store.read("CL", "2026")).fixtures[0].match;
  assert.equal(detailCoverage(await store.readDetail("CL", "2026", 900001), finalMatch, clock()).players.state, "outdated-result");
  advance(1000);
  assert.equal((await replacement.step()).kind, "standings");
  const before = calls.length;
  assert.equal((await replacement.step()).state, "hydrated");
  assert.equal(calls.length, before);
  for (let i = 0; i < 4; i++) { advance(1000); assert.equal((await replacement.step()).state, "published"); }
  assert.ok(Object.values(detailCoverage(await store.readDetail("CL", "2026", 900001), finalMatch, clock()))
    .every(section => section.state === "complete"));
  assert.equal((await collector.step()).state, "standby");
});

test("foreign teams and malformed statistics cannot publish detail", async t => {
  const { collect, state, store } = await setup(t);
  state.lineups[0].team.id = 99;
  state.players[0].players[0].statistics = [];
  assert.equal((await collect(result => result.section === "lineups")).state, "failed");
  assert.equal((await collect(result => result.section === "players")).state, "failed");
  const detail = await store.readDetail("CL", "2026", 900001);
  assert.equal(detail.sections.lineups, undefined);
  assert.equal(detail.sections.players, undefined);
});


test("empty pre-match detail is unpublished; partial coverage retries sooner than the lineup cache window", () => {
  const now = Date.parse("2026-10-13T19:00:00Z");
  const match = { id: 900001, utcDate: new Date(now + 3600000).toISOString(), status: "TIMED",
    homeTeam: "Home", awayTeam: "Away", score: { home: null, away: null } };
  const stored = { payloads: { fixture: { response: [{ teams: { home: { id: 1 }, away: { id: 2 } } }] } } };
  const payload = { errors: [], paging: { current: 1, total: 1 }, results: 0, response: [] };
  for (const section of ["events", "lineups", "players"])
    assert.equal(validateDetailPayload(payload, { match, section }, stored), "unpublished");
  const key = detailKey("CL", "2026", match.id);
  const meta = { observedAt: now, subject: detailSubject(match), coverage: "partial" };
  const manifests = new Map([[key, { sections: { fixture: { ...meta, coverage: "complete" }, lineups: meta } }]]);
  const snapshots = { CL: { fixtures: [{ match }] } };
  assert.equal(detailJobs(snapshots, { CL: "2026" }, manifests, now).find(job => job.section === "lineups").due, now + 30000);
  match.utcDate = new Date(now + 3 * 3600000).toISOString();
  assert.deepEqual(detailJobs(snapshots, { CL: "2026" }, manifests, now), []);
});
