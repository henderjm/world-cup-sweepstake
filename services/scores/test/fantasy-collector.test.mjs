import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadHandler } from '../read-handler.mjs';
import { ScoreCollector } from '../collector.mjs';
import { ScoreProvider } from '../provider.mjs';
import { DynamoScoreStore } from '../dynamodb.mjs';
import { client, createTable, deleteTable } from './support.mjs';

async function setup(t, limit = 1000) {
  const db = client(), tableName = await createTable(db);
  t.after(async () => { try { await deleteTable(db, tableName); } finally { db.destroy(); } });
  let now = Date.parse('2026-10-13T18:00:00Z') - 61000;
  const clock = () => now, store = new DynamoScoreStore({ client: db, tableName, now: clock });
  await store.initializeBudget(await store.claim('bootstrap'), { dailyLimit: limit, minuteLimit: 300, scoreReserve: 100 }, 0);
  now += 61000;
  const teams = [{ id: 42, name: 'Arsenal' }, { id: 49, name: 'Chelsea' }], calls = [], state = { badPage: false };
  const provider = new ScoreProvider({ store, now: clock, apiKey: 'synthetic', fetch: async url => {
    calls.push({ path: url.pathname + url.search, at: now });
    const year = Number(url.searchParams.get('season')), page = Number(url.searchParams.get('page') ?? 1);
    let response, total = 1;
    if (url.pathname === '/players/squads') {
      const team = teams.find(team => team.id === Number(url.searchParams.get('team')));
      response = [{ team, players: Array.from({ length: 11 }, (_, i) => ({ id: team.id * 100 + i, name: `Player ${i}`, position: 'Defence' })) }];
    } else if (url.pathname === '/players') {
      total = 2;
      response = [{ player: { id: 4199 + page, name: `Player ${page}` }, statistics: [{ team: teams[0], league: { id: 39, season: year },
        games: { appearences: 10, minutes: 900 }, goals: { total: 2, assists: 1 } }] }];
    } else if (url.pathname === '/fixtures') response = [{ fixture: { id: 900001,
      date: new Date(now - 60000).toISOString(), status: { short: url.searchParams.has('ids') ? '1H' : 'FT', elapsed: 1 } },
      league: { id: 39, season: url.searchParams.has('ids') ? 2026 : year }, teams: { home: teams[0], away: teams[1] }, goals: { home: 1, away: 0 } }];
    else throw Error(`Unexpected provider path ${url}`);
    return Response.json({ errors: [], response, results: response.length,
      paging: { current: state.badPage && page === 2 ? 1 : page, total } });
  } });
  let collector = new ScoreCollector({ store, provider, seasons: { PL: '2026' }, owner: 'collector', now: clock });
  async function seed(live = false) {
    if (live) now += 16000;
    const lease = await store.claim(collector.owner), old = await store.read('PL', '2026');
    await store.publish(lease, { competition: 'PL', season: '2026', baseVersion: old?.version ?? 0, scheduleObservedAt: now,
      fixtures: [{ observedAt: live ? now - 16000 : now, match: { id: 900001,
        utcDate: new Date(now + (live ? -60000 : 2 * 86400000)).toISOString(), status: live ? 'IN_PLAY' : 'TIMED',
        homeTeam: 'Arsenal', awayTeam: 'Chelsea', score: { home: live ? 0 : null, away: live ? 0 : null } } }],
      standings: { observedAt: now, rows: [{ type: 'TOTAL', table: teams.map(team => ({ team, points: 0, playedGames: 0 })) }] } });
  }
  await seed();
  async function step() {
    const before = calls.length; now += 1000;
    const result = await collector.step(); assert.ok(calls.length - before <= 1, 'at most one provider call per step');
    return result;
  }
  async function until(predicate) {
    for (let i = 0; i < 100; i++) { const event = await step(); if (predicate(event)) return event; }
    throw Error('Collector did not reach expected state');
  }
  return { store, state, calls, clock, step, until, seed, advance: ms => { now += ms; },
    restart: (owner = 'collector') => { collector = new ScoreCollector({ store, provider, seasons: { PL: '2026' }, owner, now: clock }); } };
}

test('squads and three complete historical seasons share the durable budget and preserve oldest observation time', async t => {
  const { store, calls, until, restart, step, clock } = await setup(t);
  await until(event => event.state === 'published' && event.kind === 'fantasy' && event.season === '2023');
  const squads = await store.readFantasy('PL', '2026', 'squads');
  assert.equal(squads.data.players.length, 22); assert.equal(squads.data.complete, true);
  const history = await store.readFantasy('PL', '2025', 'history');
  assert.equal(history.data.stats.length, 2); assert.equal(history.data.stats[0][1].minutes, 900);
  assert.equal(history.observedAt, calls.find(call => call.path.includes('season=2025')).at);
  assert.equal((await store.readBudget()).used, calls.length); assert.equal(calls.length, 11);
  const handler = createReadHandler({ store, seasons: { PL: '2026' }, now: clock });
  const response = await handler({ version: '2.0', rawPath: '/PL/players', requestContext: { http: { method: 'GET' } } });
  assert.equal(response.statusCode, 200);
  const pool = JSON.parse(response.body);
  assert.deepEqual(pool.degraded, []);
  assert.equal(pool.players.length, 22); assert.equal(pool.players[0].tier, 'starter');
  assert.equal(pool.players[0].xpBasis, 'history'); assert.equal(pool.players[0].id, 4200);
  assert.equal(calls.length, 11, 'reading the player pool never calls the provider');
  restart(); const count = calls.length;
  for (let i = 0; i < 6; i++) await step();
  assert.equal(calls.length, count, 'fresh datasets hydrate without recollecting');
});

test('due live score interrupts history pagination before the next supplementary request', async t => {
  const { calls, until, seed, step } = await setup(t);
  await until(event => event.state === 'collecting' && event.dataset === 'history');
  assert.match(calls.at(-1).path, /page=1/);
  await seed(true);
  const event = await step(); assert.equal(event.kind, 'live'); assert.equal(event.state, 'published');
  assert.match(calls.at(-1).path, /^\/fixtures\?ids=/);
});

test('score reserve defers incomplete fantasy collection while score work remains admitted', async t => {
  const { calls, until, seed, step, store } = await setup(t, 101);
  const event = await until(event => event.state === 'deferred' && event.reason === 'score-reserve');
  assert.equal(event.kind, 'fantasy'); assert.equal(calls.length, 1);
  assert.equal(await store.readFantasy('PL', '2026', 'squads'), null);
  await seed(true); const score = await step();
  assert.equal(score.kind, 'live'); assert.equal(score.state, 'published'); assert.equal(calls.length, 2);
});

test('a malformed refresh page preserves the complete previous dataset and its source age', async t => {
  const { store, state, until, advance, seed, restart } = await setup(t);
  await until(event => event.state === 'published' && event.dataset === 'history' && event.season === '2025');
  const before = await store.readFantasy('PL', '2025', 'history');
  advance(7 * 86400000 + 61000); await seed(); restart(); state.badPage = true;
  const failed = await until(event => event.state === 'failed' && event.dataset === 'history');
  assert.equal(failed.phase, 'validation');
  const after = await store.readFantasy('PL', '2025', 'history');
  assert.equal(after.version, before.version); assert.equal(after.observedAt, before.observedAt);
  assert.deepEqual(after.data, before.data);
});

test('takeover discards partial history and restarts validation without losing completed squads', async t => {
  const { store, calls, until, advance, restart } = await setup(t);
  await until(event => event.state === 'collecting' && event.dataset === 'history');
  assert.equal(await store.readFantasy('PL', '2025', 'history'), null);
  advance(30001); restart('standby');
  await until(event => event.state === 'published' && event.dataset === 'history');
  const firstPages = calls.filter(call => call.path === '/players?league=39&season=2025&page=1');
  assert.equal(firstPages.length, 2);
  const history = await store.readFantasy('PL', '2025', 'history');
  assert.equal(history.observedAt, firstPages[1].at); assert.equal(history.collectorEpoch, 3);
  assert.equal(calls.filter(call => call.path.startsWith('/players/squads')).length, 2);
});
