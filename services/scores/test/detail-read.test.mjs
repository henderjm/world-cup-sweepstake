import assert from "node:assert/strict";
import test from "node:test";
import { createReadHandler } from "../read-handler.mjs";
import { DynamoScoreStore } from "../dynamodb.mjs";
import { detailSubject } from "../details.mjs";
import { mapApiFootballMatches } from "../../../src/mapApiFootball.js";
import { isSettleableDetail } from "../../../src/fantasyScoring.js";
import { client, createTable, deleteTable } from "./support.mjs";

const event = (path = "/CL/match/900001", method = "GET") => ({ version: "2.0", rawPath: path, requestContext: { http: { method } } });
async function setup(t) {
  const db = client(), tableName = await createTable(db);
  t.after(async () => { try { await deleteTable(db, tableName); } finally { db.destroy(); } });
  let now = Date.now();
  const clock = () => now;
  const store = new DynamoScoreStore({ client: db, tableName, now: clock });
  const raw = { fixture: { id: 900001, date: new Date(now - 2 * 3600000).toISOString(),
    status: { short: "FT", elapsed: 90 }, referee: "Known Referee" }, league: { id: 2, season: 2026 },
    teams: { home: { id: 1, name: "Home" }, away: { id: 2, name: "Away" } },
    goals: { home: 0, away: 0 }, score: { halftime: { home: 0, away: 0 } } };
  const match = mapApiFootballMatches({ response: [raw] })[0];
  const snapshot = { competition: "CL", season: "2026", baseVersion: 0, scheduleObservedAt: now,
    fixtures: [{ match, observedAt: now, providerUpdatedAt: null }] };
  const lease = await store.claim("writer");
  await store.publish(lease, snapshot);
  let version = 0;
  const publish = async (section, response, coverage = "complete") => store.publishDetail(lease, {
    competition: "CL", season: "2026", id: match.id, baseVersion: version++, section,
    observedAt: now, subject: detailSubject(match), coverage, payload: { response },
  });
  const complete = async () => {
    await publish("fixture", [raw]);
    await publish("lineups", [1, 2].map(id => ({ team: { id }, startXI: Array.from({ length: 11 }, (_, n) => ({ player: { id: id * 100 + n, name: `Player ${id}-${n}` } })), substitutes: [] })));
    await publish("events", []);
    await publish("players", [1, 2].map(id => ({ team: { id }, players: Array.from({ length: 11 }, (_, n) => ({ player: { id: id * 100 + n, name: `Player ${id}-${n}` },
      statistics: [{ games: { minutes: 90, position: "D" }, tackles: { total: 0, blocks: 0, interceptions: 0 } }] })) })));
  };
  const commands = [];
  const reader = new DynamoScoreStore({ tableName, now: clock, client: { send(command, options) {
    commands.push(command); return db.send(command, options);
  } } });
  const handler = createReadHandler({ store: reader, seasons: { CL: 2026 }, now: clock });
  return { store, snapshot, match, raw, publish, complete, handler, commands, advance: ms => { now += ms; }, clock };
}

test("unknown routes and fixture IDs never request detail or provider data", async () => {
  let reads = 0, details = 0;
  const handler = createReadHandler({ store: { read: async () => { reads++; return { competition: "CL", season: "2026", fixtures: [] }; },
    readDetail: async () => { details++; } }, seasons: { CL: 2026 } });
  for (const path of ["/PL/match/900001", "/CL/match/0", "/CL/match/no", "/CL/match/1"]) assert.equal((await handler(event(path))).statusCode, 404);
  assert.equal((await handler(event("/CL/match/1", "POST"))).statusCode, 405);
  assert.equal(reads, 1); assert.equal(details, 0);
});

test("a known fixture without details remains openable and cannot settle", async t => {
  const { handler } = await setup(t);
  const result = await handler(event()), detail = JSON.parse(result.body);
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(detail.home.name, "Home"); assert.equal(detail.score.home, 0);
  assert.equal(detail.coverage.lineups.state, "missing");
  assert.equal(detail.degraded.length, 4); assert.equal(isSettleableDetail(detail), false);
});

test("complete fresh stored detail preserves referee and halftime with only strongly consistent reads", async t => {
  const { complete, handler, commands, store } = await setup(t);
  await complete();
  const result = await handler(event()), detail = JSON.parse(result.body);
  assert.equal(result.statusCode, 200); assert.equal(detail.referee, "Known Referee");
  assert.equal(detail.score.htHome, 0); assert.equal(detail.playerStats[0].tackles, 0);
  assert.deepEqual(detail.degraded, []); assert.equal(isSettleableDetail(detail), true);
  assert.ok(commands.every(command => command.constructor.name === "GetItemCommand" && command.input.ConsistentRead));
  assert.equal(await store.readBudget(), null);
});

test("unknown played-player statistics remain null and block settlement", async t => {
  const { complete, publish, handler } = await setup(t);
  await complete();
  await publish("players", [{ team: { id: 1 }, players: [{ player: { id: 1, name: "Player 1" },
    statistics: [{ games: { minutes: 90, position: "D" }, tackles: { total: null } }] }] }]);
  const detail = JSON.parse((await handler(event())).body);
  assert.equal(detail.playerStats[0].tackles, null); assert.equal(detail.playerStats[0].blocks, null);
  assert.equal(detail.coverage.players.state, "partial"); assert.equal(isSettleableDetail(detail), false);
});

test("newer canonical score wins without refreshing old timeline or player timestamps", async t => {
  const { complete, store, handler, snapshot, clock, advance } = await setup(t);
  await complete(); const first = clock(); advance(1000);
  const next = structuredClone(snapshot); next.baseVersion = 1; next.scheduleObservedAt = clock();
  next.fixtures[0].match.score.home = 1; next.fixtures[0].observedAt = clock();
  await store.publish(await store.claim("writer"), next);
  const detail = JSON.parse((await handler(event())).body);
  assert.equal(detail.score.home, 1); assert.equal(detail.coverage.events.observedAt, first);
  assert.equal(detail.coverage.events.state, "outdated-result"); assert.equal(detail.coverage.players.state, "outdated-result");
  assert.equal(isSettleableDetail(detail), false);
});

test("an expired section and an expired score keep their own ages", async t => {
  const { complete, handler, advance, clock } = await setup(t);
  await complete(); const observed = clock(); advance(6 * 3600000 + 1);
  const detail = JSON.parse((await handler(event())).body);
  assert.equal(detail.coverage.players.state, "stale"); assert.equal(detail.coverage.players.observedAt, observed);
  assert.equal(detail.stale, true); assert.equal(detail.staleAgeMs, 6 * 3600000 + 1);
  assert.equal(isSettleableDetail(detail), false);
});

test("database failure is unavailable, not missing or empty detail", async () => {
  const handler = createReadHandler({ store: { read: async () => { throw Error("offline"); } }, seasons: { CL: 2026 } });
  assert.equal((await handler(event())).statusCode, 503);
});


test("missing participant minutes cannot be treated as an unused bench player", async t => {
  const { complete, publish, handler } = await setup(t);
  await complete();
  await publish("players", [{ team: { id: 1 }, players: [{ player: { id: 100, name: "Player 1-0" },
    statistics: [{ games: { minutes: null, position: "D" }, tackles: { total: 0, blocks: 0, interceptions: 0 } }] }] }]);
  const detail = JSON.parse((await handler(event())).body);
  assert.equal(detail.playerStats[0].minutes, null);
  assert.equal(detail.coverage.players.state, "partial");
  assert.equal(isSettleableDetail(detail), false);
});
