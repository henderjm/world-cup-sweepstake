import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
const scenario = process.env.FEEDER_TEST_SCENARIO;
const realTime = scenario === 'real-body-stall';
const start = realTime ? Date.now() : Date.parse('2026-09-19T15:00:00Z');
let now = start, discoveries = 0;
const calls = [], pushes = [];
const byLeague = {};
const crowded = scenario.startsWith('crowded-');
const deadlines = new WeakMap();
let timeouts = 0;
if (!realTime) AbortSignal.timeout = milliseconds => {
  const controller = new AbortController();
  deadlines.set(controller.signal, { at: now + milliseconds, controller });
  return controller.signal;
};
function advance(milliseconds, signal) {
  const deadline = deadlines.get(signal);
  if (now + milliseconds >= deadline.at) {
    now = deadline.at;
    timeouts++;
    deadline.controller.abort(new DOMException('Request timed out', 'TimeoutError'));
    throw signal.reason;
  }
  now += milliseconds;
}
if (!realTime) Date.now = () => now;
if (!realTime) globalThis.setTimeout = (callback, milliseconds) => {
  now += milliseconds;
  queueMicrotask(callback);
  return 0;
};
globalThis.fetch = async (url, options) => {
  assert.ok(options.signal instanceof AbortSignal, 'Every feeder read/write needs a deadline');
  const parsed = new URL(url);
  const league = parsed.searchParams.get('league');
  calls.push({ path: parsed.pathname, query: parsed.search, provider: parsed.origin === 'https://v3.football.api-sports.io', at: now - start });
  if (parsed.origin === 'https://fixture.invalid') {
    if (scenario === 'crowded-ingest' && parsed.pathname.startsWith('/ingest/detail/')) advance(9000, options.signal);
    if (parsed.pathname.startsWith('/ingest/live/')) {
      if (scenario === 'failed-ingest') throw Error('Ingest unavailable');
      const body = JSON.parse(options.body);
      if (body.fixtures.response.length) pushes.push({ at: now - start, competition: parsed.pathname.split('/').at(-1), score: body.fixtures.response[0].goals.home });
    }
    return Response.json({ stored: true });
  }
  assert.equal(parsed.origin, 'https://v3.football.api-sports.io');
  if (parsed.searchParams.has('date')) {
    discoveries++;
    byLeague[league] = (byLeague[league] ?? 0) + 1;
    const count = byLeague[league];
    if (scenario === 'cl-failure' && league === '2' && count === 1) return new Response('Unavailable', { status: 503 });
    if (scenario === 'cl-empty' && league === '2' && count === 2) return Response.json({ response: [], errors: [] });
    if (scenario === 'http-limit' && discoveries === 1) return new Response('Rate limited', { status: 429 });
    if (scenario === 'payload-limit' && discoveries === 1) return Response.json({ response: [], errors: { requests: 'Allowance exhausted' } });
    if ((scenario === 'cl-idle' && league === '2') || (scenario === 'pl-idle' && league === '39') || scenario === 'both-idle') return Response.json({ response: [], errors: [] });
    if (scenario === 'transient' && discoveries === 2) return new Response('Unavailable', { status: 503 });
    if (scenario === 'first-failure' && discoveries === 1) return new Response('Unavailable', { status: 503 });
    if (scenario === 'malformed') return Response.json({});
    if (scenario === 'empty' && discoveries === 2) return Response.json({ response: [], errors: [] });
    const kickoffSoon = scenario === 'cl-kickoff' && league === '2';
    const status = kickoffSoon && now < start + 90000 ? 'NS' : scenario === 'idle' ? 'NS' : scenario === 'finished' && discoveries >= 3 ? 'FT'
      : ({ 'extra-time': 'ET', 'shootout': 'P', 'extra-break': 'BT' }[scenario] ?? '1H');
    const headers = {};
    if (['low-quota', 'critical-quota', 'quota-retained'].includes(scenario) && (scenario !== 'quota-retained' || discoveries === 1)) {
      headers['x-ratelimit-requests-limit'] = '1000';
      headers['x-ratelimit-requests-remaining'] = scenario === 'critical-quota' ? '50' : '150';
    }
    if (scenario === 'minute-empty' && discoveries === 1) headers['x-ratelimit-remaining'] = '0';
    const fixture = {
      fixture: { id: league === '2' ? 900002 : 900001, date: new Date(start + (kickoffSoon ? 90000 : status === 'NS' ? 7200000 : -1800000)).toISOString(), status: { short: status, elapsed: 30 } },
      league: { id: Number(league), season: 2026, round: league === '2' ? 'League Stage - 1' : 'Regular Season - 5' },
      teams: { home: { id: 1, name: 'Home' }, away: { id: 2, name: 'Away' } },
      goals: { home: count - 1, away: 0 },
    };
    const response = crowded && league === '2'
      ? Array.from({ length: 18 }, (_, index) => ({ ...fixture, fixture: { ...fixture.fixture, id: 910000 + index } }))
      : [fixture];
    return Response.json({ errors: [], response }, { headers });
  }
  if (scenario === 'quota-drops-in-detail') return Response.json({ response: [], errors: [] }, { headers: { 'x-ratelimit-requests-limit': '1000', 'x-ratelimit-requests-remaining': '149' } });
  if (scenario === 'crowded-headers') advance(11000, options.signal);
  const response = Response.json({ response: [], errors: [] });
  if (realTime) {
    response.json = () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ response: [], errors: [] }), 2000);
      options.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        timeouts++;
        reject(options.signal.reason);
      }, { once: true });
    });
  }
  if (crowded) {
    response.json = async () => {
      advance(scenario === 'crowded-stall' ? 11000 : 9000, options.signal);
      return { response: [], errors: [] };
    };
  }
  return response;
};
process.on('exit', () => writeFileSync(process.env.FEEDER_TEST_RESULT, JSON.stringify({ calls, pushes, discoveries, byLeague, timeouts, elapsed: Date.now() - start })));
