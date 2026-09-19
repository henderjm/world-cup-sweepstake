import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../src/data.js';
import { updatedLabel } from '../src/format.js';

test('memo and shared-cache score reads keep source age through polls and later failure', async t => {
  let now = Date.parse('2026-09-19T15:00:00Z'), score = 1, fail = false, batchReads = 0;
  t.mock.method(Date, 'now', () => now);
  const entries = new Map(), previous = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: {
    match: async key => entries.get(key)?.clone(),
    put: async (key, value) => { entries.set(key, value.clone()); },
  } } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'caches', previous) : delete globalThis.caches);
  t.mock.method(globalThis, 'fetch', async url => {
    const path = new URL(url);
    if (path.pathname === '/standings') return Response.json({ errors: [], response: [] });
    if (path.searchParams.has('ids')) {
      batchReads++;
      if (fail) return new Response('Unavailable', { status: 503 });
    }
    return Response.json({ errors: [], response: [{
      fixture: { id: 900001, date: '2026-09-19T14:30:00Z', status: { short: '1H', elapsed: 30 } },
      league: { id: 2, season: 2026, round: 'League Stage - 1' },
      teams: { home: { id: 1, name: 'Home' }, away: { id: 2, name: 'Away' } },
      goals: { home: score, away: 0 }, score: { fulltime: { home: null, away: null } },
    }] });
  });
  const { default: worker } = await import('../worker/worker.js?score-age');
  const env = { API_FOOTBALL_KEY: 'fixture', API_FOOTBALL_COMPETITIONS: 'CL:2026' };
  const read = async (target = worker) => (await target.fetch(new Request('https://test.invalid/CL/live'), env, { waitUntil() {} })).json();
  const initial = await read();
  now += 20000;
  const memo = await read();
  assert.equal(memo.lastUpdated, initial.lastUpdated, 'A browser poll re-dated cached scores');
  assert.equal(batchReads, 1);
  assert.match(updatedLabel({ fetchedAt: now, now, updatedAt: Date.parse(memo.lastUpdated), stale: false }).text, /20s ago/);
  now += 20000;
  const { default: cold } = await import('../worker/worker.js?score-age-cold');
  assert.equal((await read(cold)).lastUpdated, initial.lastUpdated);
  assert.equal(batchReads, 1, 'Shared cache caused another provider read');
  now += 21000; score = 2;
  const fresh = await read();
  assert.equal(fresh.lastUpdated, new Date(now).toISOString());
  assert.equal(fresh.matches[0].score.home, 2);
  now += 130000; fail = true;
  const concurrent = await Promise.all([read(), read()]);
  for (const data of concurrent) {
    assert.equal(data.lastUpdated, fresh.lastUpdated, 'Coalesced stale scores were re-dated');
    assert.equal(data.matches[0].score.home, 2);
    assert.equal(buildModel(data).stale, true);
  }
  entries.clear(); now += 61000;
  const fallback = await read();
  assert.equal(fallback.lastUpdated, fresh.lastUpdated);
  assert.equal(fallback.staleAgeMs, 191000, 'Isolate fallback reset the source age');
});
