import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
const start = Date.parse('2026-09-19T15:00:00Z');
let now = start, discoveries = 0;
const calls = [], pushes = [];
const scenario = process.env.FEEDER_TEST_SCENARIO;
Date.now = () => now;
globalThis.setTimeout = (callback, milliseconds) => {
  now += milliseconds;
  queueMicrotask(callback);
  return 0;
};
globalThis.fetch = async (url, options) => {
  assert.ok(options.signal instanceof AbortSignal, 'Every feeder read/write needs a deadline');
  const parsed = new URL(url);
  calls.push({ path: parsed.pathname, at: now - start });
  if (parsed.origin === 'https://fixture.invalid') {
    if (parsed.pathname.startsWith('/ingest/live/')) {
      if (scenario === 'failed-ingest') throw Error('Ingest unavailable');
      const body = JSON.parse(options.body);
      if (body.fixtures.response.length) pushes.push({ at: now - start, score: body.fixtures.response[0].goals.home });
    }
    return Response.json({ stored: true });
  }
  assert.equal(parsed.origin, 'https://v3.football.api-sports.io');
  if (parsed.searchParams.has('date')) {
    discoveries++;
    if (scenario === 'transient' && discoveries === 2) return new Response('Unavailable', { status: 503 });
    if (scenario === 'first-failure' && discoveries === 1) return new Response('Unavailable', { status: 503 });
    if (scenario === 'malformed') return Response.json({});
    if (scenario === 'empty' && discoveries === 2) return Response.json({ response: [], errors: [] });
    const status = scenario === 'idle' ? 'NS' : scenario === 'finished' && discoveries >= 3 ? 'FT' : '1H';
    return Response.json({ errors: [], response: [{
      fixture: { id: 900001, date: new Date(start + (status === 'NS' ? 7200000 : -1800000)).toISOString(), status: { short: status, elapsed: 30 } },
      league: { id: 39, season: 2026, round: 'Regular Season - 5' },
      teams: { home: { id: 1, name: 'Home' }, away: { id: 2, name: 'Away' } },
      goals: { home: discoveries - 1, away: 0 },
    }] });
  }
  return Response.json({ response: [], errors: [] });
};
process.on('exit', () => writeFileSync(process.env.FEEDER_TEST_RESULT, JSON.stringify({ calls, pushes, discoveries, elapsed: now - start })));
