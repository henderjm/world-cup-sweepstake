import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { ScoreCollector, scoreJobs } from "../collector.mjs";
import { ScoreProvider } from "../provider.mjs";
import { DynamoScoreStore } from "../dynamodb.mjs";
import { createScoreReadApi } from "../snapshots.mjs";
import { client, createTable, deleteTable, endpoint } from "./support.mjs";

const start = Date.parse("2026-10-13T19:30:00Z");
function fixture(id, league = 2, now = start) {
  return { fixture: { id, date: new Date(now - 1800000).toISOString(), status: { short: "1H", elapsed: 30 } },
    league: { id: league, season: 2026, round: "League Stage - 2" },
    teams: { home: { name: "Arsenal" }, away: { name: "Real Madrid" } }, goals: { home: 1, away: 0 } };
}

async function setup(t, records = [fixture(900001)], { at = start, bootstrapAt = at - 61000, used = 0 } = {}) {
  const db = client(), tableName = await createTable(db);
  let now = bootstrapAt;
  const clock = () => now, calls = [], state = { records, alter: body => body };
  const store = new DynamoScoreStore({ client: db, tableName, now: clock });
  await store.initializeBudget(await store.claim("bootstrap"), { dailyLimit: 1000, minuteLimit: 300, scoreReserve: 100 }, used);
  now = at;
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost"); calls.push(url.pathname + url.search);
    const ids = url.searchParams.get("ids")?.split("-").map(Number);
    const rows = state.records.filter(row => ids ? ids.includes(row.fixture.id) : row.league.id === Number(url.searchParams.get("league")));
    const body = state.alter({ errors: [], results: rows.length, paging: { current: 1, total: 1 }, response: rows }, url);
    res.writeHead(body.httpStatus ?? 200, { "Content-Type": "application/json" }); res.end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    try { await deleteTable(db, tableName); } finally { db.destroy(); }
  });
  const providerEndpoint = `http://127.0.0.1:${server.address().port}`;
  const provider = new ScoreProvider({ store, apiKey: "localtest", now: clock,
    fetch: (url, options) => fetch(new URL(url.pathname + url.search, providerEndpoint), options) });
  const collector = new ScoreCollector({ store, provider, seasons: { CL: 2026 }, owner: "collector", now: clock });
  return { db, tableName, store, provider, collector, state, calls, clock, providerEndpoint, advance: ms => { now += ms; } };
}

test("live batches precede optional jobs and one failed batch retains its individual observations", async t => {
  const records = Array.from({ length: 22 }, (_, i) => fixture(900001 + i));
  const { store, collector, state, calls, clock, advance } = await setup(t, records);
  assert.equal((await collector.step()).kind, "discovery");
  const original = await store.read("CL", "2026");
  advance(16000);
  state.records = records.map(row => ({ ...row, goals: { home: 2, away: 0 } }));
  state.alter = (body, url) => url.searchParams.get("ids")?.startsWith("900001")
    ? { ...body, response: body.response.slice(1), results: body.results - 1 } : body;
  const failed = await collector.step();
  assert.equal(failed.state, "failed"); assert.equal(failed.kind, "live");
  advance(1000);
  assert.equal((await collector.step()).state, "published");
  const stored = await store.read("CL", "2026");
  assert.equal(stored.fixtures[0].match.score.home, 1);
  assert.equal(stored.fixtures[0].observedAt, original.fixtures[0].observedAt);
  assert.equal(stored.fixtures[21].match.score.home, 2);
  assert.equal(stored.fixtures[21].observedAt, clock());
  assert.ok(calls.slice(1).every(path => path.startsWith("/fixtures?ids=")));
  assert.ok(calls.slice(1).every(path => new URL(path, "http://localhost").searchParams.get("ids").split("-").length <= 20));
});

test("full paginated discovery publishes only after the last validated page", async t => {
  const { collector, store, provider, state, clock, advance, calls } = await setup(t, [fixture(900001), fixture(900002)]);
  state.alter = (body, url) => {
    const page = Number(url.searchParams.get("page") ?? 1), response = [body.response[page - 1]];
    return { ...body, results: 1, paging: { current: page, total: 2 }, response };
  };
  assert.equal((await collector.step()).state, "discovering");
  assert.equal(await store.read("CL", "2026"), null);
  advance(31000);
  const replacement = new ScoreCollector({ store, provider, seasons: { CL: 2026 }, owner: "replacement", now: clock });
  assert.equal((await replacement.step()).state, "discovering");
  advance(1000);
  assert.equal((await replacement.step()).state, "published");
  assert.equal((await store.read("CL", "2026")).fixtures.length, 2);
  assert.equal(calls.filter(path => path.includes("page=2")).length, 1);
});

test("wrong competition, season, unknown status and inconsistent pages cannot publish an empty or fresh feed", async t => {
  const { collector, store, state, advance } = await setup(t);
  const variants = [
    body => ({ ...body, paging: undefined }),
    body => ({ ...body, response: [], results: 1 }),
    body => ({ ...body, response: [{ ...body.response[0], league: { id: 39, season: 2026 } }] }),
    body => ({ ...body, response: [{ ...body.response[0], league: { id: 2, season: 2025 } }] }),
    body => ({ ...body, response: [{ ...body.response[0], fixture: { ...body.response[0].fixture, status: { short: "UNKNOWN" } } }] }),
  ];
  for (const alter of variants) {
    state.alter = alter;
    assert.equal((await collector.step()).state, "failed");
    assert.equal(await store.read("CL", "2026"), null);
    advance(31000);
  }
  state.alter = body => body;
  assert.equal((await collector.step()).state, "published");
});

test("validated empty discovery is readable but later missing known fixtures cannot erase results", async t => {
  const { collector, store, state, advance } = await setup(t, []);
  assert.equal((await collector.step()).state, "published");
  assert.equal((await store.read("CL", "2026")).fixtures.length, 0);
  advance(15 * 60000); state.records = [fixture(900001)];
  assert.equal((await collector.step()).state, "published");
  const snapshot = await store.read("CL", "2026");
  state.records = []; advance(15 * 60000);
  assert.equal((await collector.step()).state, "failed");
  advance(1000);
  assert.equal((await collector.step()).state, "failed");
  assert.deepEqual(await store.read("CL", "2026"), snapshot);
});

test("replacement collector resumes stored live jobs and retains stale scores during quota errors", async t => {
  const { collector, store, provider, state, clock, advance, calls } = await setup(t);
  await collector.step();
  state.alter = body => ({ ...body, errors: { rateLimit: "slow down" }, response: [], results: 0 });
  advance(16000);
  assert.equal((await collector.step()).state, "failed");
  advance(31000);
  const replacement = new ScoreCollector({ store, provider, seasons: { CL: 2026 }, owner: "replacement", now: clock });
  assert.equal((await replacement.step()).state, "deferred");
  const api = createScoreReadApi({ readSnapshot: (code, season) => store.read(code, season), seasons: { CL: 2026 }, now: clock });
  const feed = await (await api(new Request("https://scores.test/CL/live"))).json();
  assert.equal(feed.matches[0].score.home, 1); assert.equal(feed.stale, true);
  assert.equal(feed.staleAgeMs, 47000); assert.equal(calls.length, 2);
  advance(31000); state.alter = body => body; state.records[0].goals.home = 2;
  assert.equal((await replacement.step()).state, "published");
  assert.equal((await store.read("CL", "2026")).fixtures[0].match.score.home, 2);
  assert.equal((await collector.step()).state, "standby");
});

test("PL and CL cold discovery remain isolated and schedules keep running across midnight", async t => {
  const { store, provider, clock, advance } = await setup(t, [fixture(900001), fixture(900002, 39)]);
  const collector = new ScoreCollector({ store, provider, seasons: { PL: 2026, CL: 2026 }, now: clock });
  await collector.step(); advance(1000); await collector.step();
  assert.equal((await store.read("CL", "2026")).fixtures[0].match.id, 900001);
  assert.equal((await store.read("PL", "2026")).fixtures[0].match.id, 900002);
  const cl = await store.read("CL", "2026");
  const midnight = Date.parse("2026-10-14T00:00:01Z");
  assert.equal(scoreJobs({ CL: cl }, { CL: "2026" }, midnight).filter(job => job.kind === "live").length, 1);
});

test("halftime, extra time and penalties keep polling; terminal scores stop live jobs and allow later corrections", async t => {
  const { collector, store, state, clock, advance } = await setup(t);
  await collector.step();
  for (const [short, normalized] of [["HT", "PAUSED"], ["ET", "EXTRA_TIME"], ["P", "PENALTY_SHOOTOUT"], ["FT", "FINISHED"]]) {
    advance(16000); state.records[0].fixture.status.short = short;
    assert.equal((await collector.step()).state, "published");
    assert.equal((await store.read("CL", "2026")).fixtures[0].match.status, normalized);
  }
  assert.equal(scoreJobs({ CL: await store.read("CL", "2026") }, { CL: "2026" }, clock()).filter(job => job.kind === "live").length, 0);
  advance(15 * 60000); state.records[0].goals.home = 0;
  assert.equal((await collector.step()).kind, "discovery");
  assert.equal((await store.read("CL", "2026")).fixtures[0].match.score.home, 0);
});

test("standings preserve score ages and reject incomplete tables", async t => {
  const finished = fixture(900001); finished.fixture.status.short = "FT";
  const { collector, store, state, advance } = await setup(t, [finished]);
  await collector.step();
  const before = await store.read("CL", "2026");
  const table = [1, 2].map(id => ({ rank: id, team: { id, name: `Team ${id}` }, points: 0, goalsDiff: 0,
    all: { played: 0, win: 0, draw: 0, lose: 0, goals: { for: 0, against: 0 } } }));
  state.alter = (body, url) => url.pathname === "/standings"
    ? { ...body, results: 1, response: [{ league: { id: 2, season: 2026, standings: [table] } }] } : body;
  advance(1000);
  assert.equal((await collector.step()).kind, "standings");
  const saved = await store.read("CL", "2026");
  assert.deepEqual(saved.fixtures, before.fixtures);
  assert.equal(saved.standings.rows[0].table.length, 2);
  advance(15 * 60000); table.pop();
  assert.equal((await collector.step()).kind, "discovery");
  advance(1000);
  assert.equal((await collector.step()).phase, "validation");
  assert.deepEqual((await store.read("CL", "2026")).standings, saved.standings);
  advance(31000); table[0].points = null;
  assert.equal((await collector.step()).phase, "validation");
  assert.deepEqual((await store.read("CL", "2026")).standings, saved.standings);
});

test("the collector CLI runs real collection and exits cleanly on SIGTERM", async t => {
  const at = Date.now();
  const { tableName, store, providerEndpoint } = await setup(t, [fixture(900001, 2, at)], { at });
  const child = spawn(process.execPath, [new URL("../run-collector.mjs", import.meta.url).pathname], {
    env: { ...process.env, SCORE_TABLE_NAME: tableName, SCORE_SEASONS: "CL:2026", SCORE_DYNAMODB_ENDPOINT: endpoint, SCORE_PROVIDER_ENDPOINT: providerEndpoint },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode == null) child.kill("SIGKILL"); });
  let output = "", stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exit = once(child, "exit");
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error(`CLI publication timed out: ${stderr}`)), 10000);
    child.stdout.on("data", chunk => { output += chunk; if (output.includes('"state":"published"')) { clearTimeout(timeout); resolve(); } });
    child.once("error", reject);
  });
  child.kill("SIGTERM");
  const [code] = await exit;
  assert.equal(code, 0);
  assert.equal((await store.read("CL", "2026")).fixtures[0].match.score.home, 1);
});

test("standings keep refreshing after supplementary admission closes, behind due live scores", async t => {
  const { collector, store, provider, state, advance, calls } = await setup(t, [fixture(900001)], { used: 899 });
  await collector.step();
  const table = [1, 2].map(id => ({ rank: id, team: { id, name: `Team ${id}` }, points: 0, goalsDiff: 0,
    all: { played: 0, win: 0, draw: 0, lose: 0, goals: { for: 0, against: 0 } } }));
  state.alter = (body, url) => url.pathname === "/standings"
    ? { ...body, results: 1, response: [{ league: { id: 2, season: 2026, standings: [table] } }] } : body;
  advance(16000);
  const live = await collector.step();
  assert.equal(live.kind, "live"); assert.equal(live.state, "published");
  const before = await store.read("CL", "2026");
  advance(1000);
  const optional = await provider.request(await store.claim("collector"), "/players/squads?team=42");
  assert.equal(optional.allowed, false); assert.equal(optional.reason, "score-reserve");
  const standings = await collector.step();
  assert.equal(standings.kind, "standings"); assert.equal(standings.state, "published");
  const after = await store.read("CL", "2026");
  assert.deepEqual(after.fixtures, before.fixtures);
  assert.equal(after.standings.rows[0].table.length, 2);
  assert.equal((await store.readBudget()).used, 902);
  assert.equal(calls.length, 3);
});

test("standings still respect the absolute daily provider limit", async t => {
  const finished = fixture(900001); finished.fixture.status.short = "FT";
  const { collector, store, advance, calls } = await setup(t, [finished], { used: 999 });
  await collector.step(); advance(1000);
  const event = await collector.step();
  assert.equal(event.kind, "standings"); assert.equal(event.state, "deferred");
  assert.equal(event.reason, "daily-limit"); assert.equal(calls.length, 1);
  assert.equal((await store.readBudget()).used, 1000);
});
