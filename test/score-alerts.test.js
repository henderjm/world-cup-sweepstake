import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, unlink } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alertDestination, readLedger, advanceAlerts, saveAlertState, readAlertState, deliverAlert, dispatchAlerts } from '../scripts/lib/scoreAlerts.mjs';

const start = Date.parse('2026-10-04T14:00:00Z');
const iso = ms => new Date(ms).toISOString();
const plan = { start: iso(start), end: iso(start + 3000), intervalMs: 1000,
  origin: 'https://example.test', competitions: ['PL', 'CL'],
  fixtures: ['PL', 'CL'].map((competition, i) => ({ competition, id: i + 1, utcDate: iso(start) })) };
const destination = 'http://127.0.0.1/alerts';
function row(code, at, patch = {}) {
  return { type: 'probe', competition: code, scheduledAt: at, startedAt: at, completedAt: at + 50,
    durationMs: 50, httpStatus: 200, reason: null,
    fixtures: [{ id: code === 'PL' ? 1 : 2, status: 'IN_PLAY', reason: null, terminal: false }], ...patch };
}
const bytes = (rows, p = plan) => Buffer.from([JSON.stringify({ type: 'plan', schema: 1, plan: p }),
  ...rows.map(r => JSON.stringify(r))].join('\n') + '\n');
const ledger = rows => readLedger(bytes(rows));
const bad = (code, at) => row(code, at, { reason: 'stale-feed' });

test('closed missing slots alert per competition without waiting forever for a stalled recorder', () => {
  const before = advanceAlerts(null, ledger([]), destination, start + 999);
  assert.equal(before.events.length, 0);
  const state = advanceAlerts(before, ledger([row('PL', start)]), destination, start + 1000);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].competition, 'CL');
  assert.deepEqual(state.events[0].reasons, ['missing-observation']);
  assert.deepEqual(state.events[0].fixtureIds, [2]);
});

test('persistent incidents deduplicate and recovery retains the original incident identity', () => {
  const rows = [bad('PL', start), row('CL', start), bad('PL', start + 1000), row('CL', start + 1000),
    row('PL', start + 2000), row('CL', start + 2000)];
  const state = advanceAlerts(null, ledger(rows), destination, start + 3000);
  assert.equal(state.events.length, 2);
  assert.equal(state.events[0].kind, 'incident');
  assert.equal(state.events[1].kind, 'recovery');
  assert.equal(state.events[1].incidentId, state.events[0].id);
  assert.equal(state.competitions.PL.incident, null);
  assert.deepEqual(advanceAlerts(state, ledger(rows), destination, start + 4000), state);
  assert.deepEqual(advanceAlerts(null, ledger(rows), destination, start + 4000).events.map(e => e.id), state.events.map(e => e.id));
});

test('unknown kickoff, missing fixtures, slow responses and late observations open incidents', () => {
  for (const patch of [{ fixtures: [] }, { fixtures: [{ id: 1, status: 'TIMED', reason: 'kickoff-unconfirmed' }] },
    { completedAt: start + 1001 }, { httpStatus: 503, reason: 'http-503' }]) {
    const state = advanceAlerts(null, ledger([row('PL', start, patch), row('CL', start)]), destination, start + 1000);
    assert.equal(state.events.length, 1);
    assert.equal(state.events[0].competition, 'PL');
  }
  const slowPlan = { ...plan, end: iso(start + 5000), intervalMs: 5000 };
  const state = advanceAlerts(null, readLedger(bytes([row('PL', start, { completedAt: start + 2500, durationMs: 2500 }), row('CL', start)], slowPlan)), destination, start + 5000);
  assert.deepEqual(state.events[0].reasons, ['unusable-or-slow-api']);
});

test('fresh terminal results retire fixtures, stale finals cannot, live corrections reopen them', () => {
  const final = { id: 1, status: 'FINISHED', reason: null, terminal: true };
  const all = [row('PL', start, { fixtures: [final] }), row('CL', start),
    row('PL', start + 1000, { reason: 'old-source-time', fixtures: [final] }), row('CL', start + 1000),
    row('PL', start + 2000), row('CL', start + 2000)];
  assert.equal(advanceAlerts(null, ledger(all), destination, start + 3000).events.length, 0);
  all[0].reason = 'stale-feed';
  const state = advanceAlerts(null, ledger(all), destination, start + 3000);
  assert.deepEqual(state.events.map(e => e.kind), ['incident', 'recovery']);
});

test('an old idle schedule is not an active fixture incident, but unavailable API still alerts', () => {
  const idle = { ...plan, fixtures: [] };
  const state = advanceAlerts(null, readLedger(bytes([bad('PL', start), row('CL', start, { httpStatus: 503, reason: 'http-503' })], idle)), destination, start + 1000);
  assert.deepEqual(state.events.map(e => e.competition), ['CL']);
});

test('partial final appends are ignored, while malformed complete lines and rewritten evidence fail closed', () => {
  const base = bytes([row('PL', start)]);
  assert.equal(readLedger(Buffer.concat([base, Buffer.from('{"type":')])).slots.size, 1);
  assert.throws(() => readLedger(Buffer.concat([base, Buffer.from('invalid\n')])));
  assert.throws(() => readLedger(bytes([row('PL', start), row('PL', start)])), /Duplicate/);
  const state = advanceAlerts(null, readLedger(base), destination, start + 1000);
  assert.throws(() => advanceAlerts(state, ledger([]), destination, start + 2000), /changed/);
  assert.throws(() => advanceAlerts(state, ledger([bad('PL', start)]), destination, start + 2000), /changed/);
  assert.throws(() => advanceAlerts(state, readLedger(base), destination + 'other', start + 2000), /changed/);
});

test('destinations reject credentials, plaintext remote endpoints and query tokens', () => {
  assert.equal(alertDestination('https://alerts.example.test/ingest'), 'https://alerts.example.test/ingest');
  for (const value of ['http://alerts.example.test', 'https://secret@alerts.example.test',
    'https://alerts.example.test/?token=secret', 'file:///tmp/a', undefined]) assert.throws(() => alertDestination(value));
});

test('HTTP success is insufficient without the exact event acknowledgment', async () => {
  const event = advanceAlerts(null, ledger([]), destination, start + 1000).events[0];
  for (const body of ['ok', '{}', '{"acceptedEventId":"other"}', 'x'.repeat(5000)]) {
    assert.equal((await deliverAlert(destination, event, { fetcher: async () => new Response(body) })).accepted, false);
  }
  const success = await deliverAlert(destination, event, { token: 'test-only', fetcher: async (_url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['Idempotency-Key'], event.id);
    assert.equal(options.headers.Authorization, 'Bearer test-only');
    assert.ok(!options.body.includes('test-only'));
    assert.ok(!options.body.includes('attempts'));
    return Response.json({ acceptedEventId: event.id });
  } });
  assert.equal(success.accepted, true);
});

test('persist before sending, retry with stable IDs and do not let one competition starve the other', async () => {
  const state = advanceAlerts(null, ledger([]), destination, start + 1000);
  const saved = [], calls = [];
  let clock = start + 1000;
  const persist = async value => saved.push(structuredClone(value));
  const fetcher = async (_url, options) => {
    const e = JSON.parse(options.body); calls.push(e.id);
    assert.ok(saved.at(-1).events.find(item => item.id === e.id).attempts > 0);
    if (e.competition === 'PL' && clock === start + 1000) return new Response('', { status: 503 });
    return Response.json({ acceptedEventId: e.id });
  };
  await dispatchAlerts(state, destination, persist, { now: () => clock, fetcher });
  assert.equal(state.events[0].acknowledgedAt, null);
  assert.equal(state.events[1].acknowledgedAt, clock);
  await dispatchAlerts(state, destination, persist, { now: () => clock, fetcher });
  assert.equal(calls.length, 2, 'no immediate retry');
  clock += 5000;
  await dispatchAlerts(state, destination, persist, { now: () => clock, fetcher });
  assert.equal(calls[0], calls[2]);
  assert.equal(state.events[0].acknowledgedAt, clock);
});

test('receiver accepted but process lost its ack: restart sends same event before recovery', async () => {
  const rows = [bad('PL', start), row('CL', start), row('PL', start + 1000), row('CL', start + 1000)];
  const state = advanceAlerts(null, ledger(rows), destination, start + 2000);
  let durable, writes = 0;
  const calls = [];
  const fetcher = async (_url, options) => {
    const event = JSON.parse(options.body); calls.push(event);
    return Response.json({ acceptedEventId: event.id });
  };
  await assert.rejects(dispatchAlerts(state, destination, async value => {
    if (++writes === 2) throw Error('simulated process loss');
    durable = structuredClone(value);
  }, { now: () => start + 2000, fetcher }));
  await dispatchAlerts(durable, destination, async () => {}, { now: () => start + 7000, fetcher });
  await dispatchAlerts(durable, destination, async () => {}, { now: () => start + 7000, fetcher });
  assert.equal(calls[0].id, calls[1].id);
  assert.equal(calls[2].kind, 'recovery');
});

async function server(t, handler) {
  const s = createServer(handler);
  await new Promise((resolve, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', resolve); });
  t.after(() => { s.closeAllConnections(); s.close(); });
  return `http://127.0.0.1:${s.address().port}`;
}
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'score-alerts-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
function run(args, url) {
  const child = spawn(process.execPath, ['scripts/watch-score-reliability.mjs', ...args],
    { env: { ...process.env, SCORE_ALERT_URL: url, SCORE_ALERT_TOKEN: '' } });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}

test('real HTTP stalled acknowledgment times out and redirect is not followed', async t => {
  const url = await server(t, (req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/secret' }); res.end(); return; }
    assert.notEqual(req.url, '/secret');
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{');
  });
  const event = advanceAlerts(null, ledger([]), destination, start + 1000).events[0];
  assert.equal((await deliverAlert(url, event, { timeoutMs: 100 })).reason, 'receiver-timeout');
  assert.equal((await deliverAlert(url + '/redirect', event)).accepted, false);
});

test('CLI delivers incident and recovery to a real receiver and restart does not redeliver acknowledged events', async t => {
  const dir = await directory(t), received = [];
  const url = await server(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const event = JSON.parse(body); received.push(event);
    assert.equal(req.headers['idempotency-key'], event.id);
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ acceptedEventId: event.id }));
  });
  const at = Date.now() - 2500;
  const p = { ...plan, competitions: ['PL'], fixtures: [{ ...plan.fixtures[0], utcDate: iso(at) }], start: iso(at), end: iso(at + 2000) };
  const log = join(dir, 'observations.jsonl'), statePath = join(dir, 'alerts.json');
  await writeFile(log, bytes([bad('PL', at), row('PL', at + 1000)], p));
  const result = await run([log, statePath], url).done;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(received.map(e => e.kind), ['incident', 'recovery']);
  const persisted = JSON.parse(await readFile(statePath, 'utf8'));
  assert.ok(persisted.events.every(e => e.acknowledgedAt >= e.detectedAt));
  assert.equal(JSON.parse(result.stdout).pending, 0);
  assert.equal((await run([log, statePath], url).done).code, 0);
  assert.equal(received.length, 2);
  await writeFile(statePath + '.lock', '{"pid":999999}\n');
  const locked = await run([log, statePath], url).done;
  assert.equal(locked.code, 1); assert.match(locked.stderr, /Watcher lock exists/);
  assert.equal(received.length, 2);
});

test('durable state survives replacement; denied persistence prevents all network calls', async t => {
  const dir = await directory(t), path = join(dir, 'alerts.json');
  const state = advanceAlerts(null, ledger([]), destination, start + 1000);
  await saveAlertState(path, state);
  const contents = await readFile(path, 'utf8');
  assert.deepEqual(readAlertState(contents), state);
  assert.throws(() => readAlertState(contents.replace('"attempts":0', '"attempts":1')), /checksum mismatch/);
  let called = false;
  await assert.rejects(dispatchAlerts(state, destination, async () => { throw Error('disk full'); }, {
    now: () => start + 1000, fetcher: async () => { called = true; },
  }), /disk full/);
  assert.equal(called, false);
});

async function until(check, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await sleep(25); }
  throw Error('Timed out waiting for local process evidence');
}

test('real recorder stall and loss reach the receiver; killed watcher resumes its unacknowledged event', { timeout: 20000 }, async t => {
  const dir = await directory(t), received = [], accepted = new Set();
  let reject = true;
  const url = await server(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const event = JSON.parse(body); received.push(event);
    if (reject) { res.writeHead(503); res.end(); return; }
    accepted.add(event.id);
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ acceptedEventId: event.id }));
  });
  let calls = 0;
  const origin = await server(t, (_req, res) => {
    calls++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ competition: 'PL', lastUpdated: iso(Date.now() - (calls === 2 ? 120000 : 0)),
      matches: [{ id: 1, status: 'IN_PLAY', score: { home: 1, away: 0 } }] }));
  });
  const at = Date.now() + 800;
  const p = { ...plan, origin, competitions: ['PL'], start: iso(at), end: iso(at + 5000),
    fixtures: [{ competition: 'PL', id: 1, utcDate: iso(at) }] };
  const planPath = join(dir, 'plan.json'), log = join(dir, 'observations.jsonl'), statePath = join(dir, 'alerts.json');
  await writeFile(planPath, JSON.stringify(p));
  const recorder = spawn(process.execPath, ['scripts/measure-score-reliability.mjs', 'record', planPath, log], { stdio: 'ignore' });
  const recorderExit = new Promise(resolve => recorder.once('exit', resolve));
  t.after(() => { if (recorder.exitCode === null) recorder.kill('SIGKILL'); });
  await until(async () => readFile(log, 'utf8').then(text => text.includes('\n')).catch(() => false));
  let watcher = run([log, statePath], url);
  t.after(() => { if (watcher.child.exitCode === null) watcher.child.kill('SIGKILL'); });
  await until(() => received.length === 1);
  assert.deepEqual(received[0].reasons, ['old-source-time']);
  watcher.child.kill('SIGKILL'); await watcher.done;
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(saved.events[0].acknowledgedAt, null);
  assert.equal(saved.events[0].attempts, 1);
  await until(() => calls >= 3);
  await until(async () => (await readFile(log, 'utf8')).trimEnd().split('\n').length >= 4);
  recorder.kill('SIGKILL'); await recorderExit;
  // An operator may remove only a lock whose process was confirmed terminal.
  await unlink(statePath + '.lock'); reject = false;
  watcher = run([log, statePath], url);
  const result = await watcher.done;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(received.map(e => e.kind), ['incident', 'incident', 'recovery', 'incident']);
  assert.equal(received[0].id, received[1].id, 'retry keeps the original delivery identity');
  assert.deepEqual(received.at(-1).reasons, ['missing-observation']);
  assert.equal(accepted.size, 3);
  const persisted = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(persisted.events.length, 3);
  assert.ok(persisted.events.every(e => e.acknowledgedAt !== null));
  assert.ok(persisted.events.every(e => e.acknowledgedAt - e.detectedAt < 10000));
  assert.equal(calls, 3, 'watcher does not fetch scores or contact the provider');
});
