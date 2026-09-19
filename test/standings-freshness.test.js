import test from 'node:test';
import assert from 'node:assert/strict';

test('standings preserve their source time through memo, shared cache, refusal and recovery', async t => {
  const initialTime = Date.parse('2026-09-19T14:00:00Z');
  let now = initialTime, score = 1, mode = 'healthy', points = 3, tableReads = 0;
  t.mock.method(Date, 'now', () => now);
  const cache = new Map();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: {
    match: async key => cache.get(key)?.clone(),
    put: async (key, response) => { cache.set(key, response.clone()); },
  } } });
  t.after(() => descriptor ? Object.defineProperty(globalThis, 'caches', descriptor) : delete globalThis.caches);
  t.mock.method(globalThis, 'fetch', async url => {
    if (new URL(url).pathname === '/standings') {
      tableReads++;
      if (mode === 'error') return new Response('Unavailable', { status: 503 });
      return Response.json({ errors: [], response: mode === 'empty' ? [] : [{ league: { standings: [[{
        rank: 1, team: { id: 1, name: 'Home' }, points, all: { played: 1, win: 1, draw: 0, lose: 0, goals: { for: 1, against: 0 } },
      }]] } }] });
    }
    return Response.json({ errors: [], response: [{
      fixture: { id: 900001, date: '2026-09-19T13:30:00Z', status: { short: '1H', elapsed: 30 } },
      league: { id: 2, season: 2026, round: 'League Stage - 1' },
      teams: { home: { id: 1, name: 'Home' }, away: { id: 2, name: 'Away' } },
      goals: { home: score, away: 0 }, score: { fulltime: { home: null, away: null } },
    }] });
  });
  const env = { API_FOOTBALL_KEY: 'fixture', API_FOOTBALL_COMPETITIONS: 'CL:2026' };
  const { default: worker } = await import('../worker/worker.js?table-time');
  const read = async (target = worker) => {
    const response = await target.fetch(new Request('https://test.invalid/CL/live'), env, { waitUntil() {} });
    assert.equal(response.status, 200);
    return response.json();
  };
  const assertFreshScore = data => {
    assert.equal(data.lastUpdated, new Date(now).toISOString());
    assert.ok(!data.stale);
    assert.equal(data.matches[0].score.home, score);
  };
  const initial = await read();
  assert.equal(initial.standingsUpdatedAt, new Date(initialTime).toISOString());
  now += 61000; score = 2;
  const memo = await read();
  assertFreshScore(memo);
  assert.equal(memo.standingsUpdatedAt, initial.standingsUpdatedAt);
  assert.equal(tableReads, 1, 'Fresh table cache should avoid extra provider reads');
  now += 300000; score = 3; mode = 'error';
  const coalesced = await Promise.all([read(), read()]);
  for (const data of coalesced) {
    assertFreshScore(data);
    assert.equal(data.standingsUpdatedAt, initial.standingsUpdatedAt);
    assert.equal(data.standingsDelayed, true);
  }
  assert.equal(tableReads, 2, 'Concurrent readers must share the refused table request');
  now += 360000; score = 4;
  const localFallback = await read();
  assertFreshScore(localFallback);
  assert.equal(localFallback.standingsUpdatedAt, initial.standingsUpdatedAt);
  assert.equal(localFallback.standingsDelayed, true);
  mode = 'empty'; now += 61000;
  const empty = await read();
  assertFreshScore(empty);
  assert.equal(empty.standings[0].table[0].points, 3);
  assert.equal(empty.standingsUpdatedAt, initial.standingsUpdatedAt);
  assert.equal(empty.standingsDelayed, true);
  mode = 'healthy'; points = 6; now += 61000;
  const recovered = await read();
  assertFreshScore(recovered);
  assert.equal(recovered.standingsDelayed, false);
  assert.equal(recovered.standingsUpdatedAt, new Date(now).toISOString());
  assert.equal(recovered.standings[0].table[0].points, 6);
  const { default: coldWorker } = await import('../worker/worker.js?cold-table-time');
  const cold = await read(coldWorker);
  assert.equal(cold.standingsUpdatedAt, recovered.standingsUpdatedAt);
  now += 360000; mode = 'error'; score = 5;
  const { default: coldStaleWorker } = await import('../worker/worker.js?cold-stale-table-time');
  const coldStale = await read(coldStaleWorker);
  assertFreshScore(coldStale);
  assert.equal(coldStale.standingsUpdatedAt, recovered.standingsUpdatedAt);
  assert.equal(coldStale.standingsDelayed, true);
});
