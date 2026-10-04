import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadHandler } from '../services/scores/read-handler.mjs';
import { storedPlayerPool } from '../services/scores/fantasy-read.mjs';
import { exportStoredPlayerPool } from '../scripts/lib/stored-player-export.mjs';

const now = Date.parse('2026-10-04T12:00:00Z');
const players = [{ id: 1, name: 'Player A', team: 'Arsenal', position: 'FWD', crest: null },
  { id: 2, name: 'Player B', team: 'Chelsea', position: 'GK', crest: null }];
const stats = { appearances: 20, lineups: 20, minutes: 1800, goals: 10, assists: 4, conceded: 0, yellow: 0, yellowRed: 0, red: 0, ownGoals: 0 };
function fixtures() {
  const base = { competition: 'PL', version: 2, collectorEpoch: 1, observedAt: now - 1000 };
  return { squads: { ...base, season: '2026', kind: 'squads', data: { complete: true, players } },
    history: Object.fromEntries(['2025', '2024', '2023'].map(season => [season, { ...base, season, kind: 'history',
      data: { stats: [[1, stats]], clubs: [[1, [['Arsenal', 20]]]], cleanSheets: [['Arsenal', 0.5]], requestCount: 3 } }])) };
}
function pool() { const { squads, history } = fixtures(); return storedPlayerPool(squads, history, '2026', now); }
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'kickoff-player-export-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'players.json');
  const run = body => exportStoredPlayerPool({ origin: 'https://stored.invalid', competition: 'PL', season: '2026', path,
    now: () => now, fetcher: async (url, options) => {
      assert.equal(url, 'https://stored.invalid/PL/players'); assert.deepEqual(options.headers, { Accept: 'application/json' });
      return body instanceof Response ? body : Response.json(body);
    } });
  return { run, path, dir, read: () => readFile(path, 'utf8') };
}

test('stored pool preserves identity, source time, tiers and historical expected points', () => {
  const body = pool();
  assert.equal(body.players[0].id, 1); assert.equal(body.players[0].tier, 'starter');
  assert.equal(body.players[0].minutes, 1800); assert.equal(body.players[0].appearances, 20);
  assert.equal(body.players[0].xpBasis, 'history'); assert.equal(body.players[0].xp, 2.4); // (20 appearances × 2 + 10 goals × 4 + 4 assists × 3) / 38 gameweeks
  assert.equal(body.players[1].tier, 'unknown'); assert.equal(body.players[1].xp, null);
  assert.equal(body.lastUpdated, new Date(now - 1000).toISOString());
  assert.deepEqual(body.degraded, []); assert.equal(body.xpStats.requestCount, 9);
});

test('missing, unavailable and malformed history remain distinguishable without fabricated estimates', () => {
  const { squads, history } = fixtures();
  history['2025'] = null; history['2024'] = undefined; history['2023'].data.stats = [[1, {}]];
  const body = storedPlayerPool(squads, history, '2026', now);
  assert.equal(body.coverage.history['2025'].state, 'missing');
  assert.equal(body.coverage.history['2024'].state, 'unavailable');
  assert.equal(body.coverage.history['2023'].state, 'invalid');
  assert.equal(body.priorSeasonStats.available, false); assert.equal(body.xpStats.available, false);
  assert.ok(body.players.every(player => player.xp === null));
});

test('read handler uses stored reads only, bounds routes and exposes squad failure as unavailable', async () => {
  const { squads, history } = fixtures(), calls = [];
  let unavailable = false;
  const handler = createReadHandler({ seasons: { PL: '2026', CL: '2026' }, now: () => now, store: {
    readFantasy: async (code, season, kind) => { calls.push([code, season, kind]); return unavailable ? null : kind === 'squads' ? squads : history[season]; },
  } });
  const request = (path = '/PL/players', method = 'GET') => handler({ version: '2.0', rawPath: path, requestContext: { http: { method } } });
  assert.equal((await request('/CL/players')).statusCode, 404); assert.equal((await request('/PL/players', 'POST')).statusCode, 405);
  assert.equal(calls.length, 0);
  const result = await request(); assert.equal(result.statusCode, 200); assert.equal(result.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(result.body), pool()); assert.equal(calls.length, 4);
  unavailable = true; assert.equal((await request()).statusCode, 503);
});

test('export preserves last-good bytes on outages, stale data, partial history and version regression', async t => {
  const { run, read } = await setup(t); await run(pool()); const before = await read();
  const variants = [new Response('offline', { status: 503 })];
  for (const change of [
    p => { p.stale = true; },
    p => { p.coverage.squads.version = 1; },
    p => { p.coverage.history['2025'].version = 1; },
    p => { p.coverage.history['2025'] = { state: 'missing' }; p.degraded = ['2025']; },
    p => { p.players[1].id = 1; },
    p => { p.lastUpdated = new Date(now).toISOString(); },
  ]) { const body = pool(); change(body); variants.push(body); }
  for (const body of variants) { await assert.rejects(run(body)); assert.equal(await read(), before); }
});

test('first export can honestly lack history; later complete export supplies it without touching source age', async t => {
  const { run, read } = await setup(t), { squads } = fixtures();
  await run(storedPlayerPool(squads, {}, '2026', now));
  assert.equal(JSON.parse(await read()).xpStats.available, false);
  await run(pool()); assert.equal(JSON.parse(await read()).xpStats.available, true);
  assert.equal(JSON.parse(await read()).lastUpdated, pool().lastUpdated);
});

test('stale and future observations are not silently refreshed by a read', () => {
  const { squads, history } = fixtures();
  const old = storedPlayerPool(squads, history, '2026', now + 15 * 86400000);
  assert.equal(old.stale, true); assert.equal(old.coverage.history['2025'].state, 'stale');
  assert.equal(old.lastUpdated, new Date(squads.observedAt).toISOString());
  assert.throws(() => storedPlayerPool(squads, history, '2026', now - 2000));
});

test('stored-mode script attempts the stored service before the legacy provider-key guard', async t => {
  const { dir } = await setup(t);
  const { spawn } = await import('node:child_process'), { pathToFileURL } = await import('node:url');
  const guard = join(dir, 'guard.mjs');
  await writeFile(guard, `globalThis.fetch = async url => {
    if (url !== 'https://stored.invalid/PL/players') process.exit(8);
    process.exit(7);
  };`);
  const child = spawn(process.execPath, ['--import', pathToFileURL(guard).href, 'scripts/fetch-fantasy-players.mjs'], {
    env: { ...process.env, API_FOOTBALL_KEY: '', SCORE_READ_ORIGIN: 'https://stored.invalid', FANTASY_COMPETITION: 'PL', API_FOOTBALL_SEASON: '2026' },
    stdio: 'ignore',
  });
  assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }), 7);
});
