import test from 'node:test';
import assert from 'node:assert/strict';

test('a queued live refresh retains its last score and recovers after a detail burst', async t => {
  const { default: worker } = await import('../worker/worker.js?queue-burst');
  let now = Date.parse('2026-09-19T12:00:00Z');
  let score = 1;
  t.mock.method(Date, 'now', () => now);
  const fixtures = () => Array.from({ length: 15 }, (_, i) => ({
    fixture: { id: 900001 + i, date: '2026-09-19T11:30:00Z', status: { short: i ? 'FT' : '1H', elapsed: i ? 90 : 30 } },
    league: { id: 2, season: 2026, round: 'League Stage - 1' },
    teams: { home: { id: 1, name: 'Home' }, away: { id: 2, name: 'Away' } },
    goals: { home: score, away: 0 }, score: { fulltime: { home: i ? score : null, away: i ? 0 : null } },
  }));
  const started = [];
  t.mock.method(globalThis, 'fetch', async url => {
    started.push(performance.now());
    const parsed = new URL(url);
    let response = [];
    if (parsed.pathname === '/fixtures') response = parsed.searchParams.has('id') ? fixtures().filter(f => f.fixture.id === Number(parsed.searchParams.get('id'))) : fixtures();
    return Response.json({ response, errors: [] });
  });
  const env = { API_FOOTBALL_KEY: 'fixture', API_FOOTBALL_COMPETITIONS: 'CL:2026' };
  const read = path => worker.fetch(new Request('https://test.invalid' + path), env, { waitUntil() {} });
  const initial = await (await read('/CL/live')).json();
  const pending = Array.from({ length: 14 }, (_, i) => read('/match/' + (900002 + i)));
  await new Promise(resolve => setTimeout(resolve, 1));
  now += 61000;
  const start = performance.now();
  const response = await read('/CL/live');
  const duration = performance.now() - start;
  const delayed = await response.json();
  assert.equal(response.status, 200);
  assert.equal(delayed.stale, true);
  assert.equal(delayed.lastUpdated, initial.lastUpdated);
  assert.equal(delayed.matches[0].score.home, 1);
  assert.ok(duration < 1500, `Queue did not release the live route promptly: ${duration}ms`);
  await Promise.all(pending);
  score = 2; now += 61000;
  const recovered = await (await read('/CL/live')).json();
  assert.equal(recovered.matches[0].score.home, 2);
  assert.ok(!recovered.stale);
  for (let i = 1; i < started.length; i++) assert.ok(started[i] - started[i - 1] >= 180, 'Provider requests bunched together');
});
