import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateSchedule } from '../scripts/run-score-schedule.mjs';
const exec = promisify(execFile);
const iso = n => new Date(n).toISOString();
function schedule(at, origin = 'http://127.0.0.1:1') {
  return { windows: [0, 1].map(i => ({ start: iso(at + i * 3000), end: iso(at + (i + 1) * 3000),
    origin, intervalMs: 1000, competitions: ['PL', 'CL'], fixtures: ['PL', 'CL'].map(competition => ({ competition, id: 1, utcDate: iso(at) })), fixtureReference: 'Synthetic active PL and CL fixtures' })) };
}
test('schedule rejects gaps, overlap, changed scope, unaligned slots and missing provenance', () => {
  const original = schedule(Date.now());
  assert.equal(validateSchedule(original).windows.length, 2);
  for (const mutate of [
    s => s.windows[1].start = iso(Date.parse(s.windows[1].start) + 1000),
    s => s.windows[1].start = s.windows[0].start,
    s => s.windows[1].competitions = ['PL'],
    s => s.windows[1].origin = 'https://example.com',
    s => s.windows[1].end = iso(Date.parse(s.windows[1].end) + 1),
    s => delete s.windows[0].fixtureReference,
  ]) {
    const input = structuredClone(original); mutate(input); assert.throws(() => validateSchedule(input));
  }
});
test('real adjacent windows keep recording while previous alerts are refused, then restart without probes or redelivery', { timeout: 25000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'score schedule-plan.json-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const probes = [], deliveries = [], accepted = new Set();
  let at;
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const event = JSON.parse(body); deliveries.push(event);
      if (Date.now() < at + 4000) { res.writeHead(503); res.end('{}'); return; }
      accepted.add(event.id); res.end(JSON.stringify({ acceptedEventId: event.id })); return;
    }
    probes.push({ at: Date.now(), path: req.url });
    res.end(JSON.stringify({ competition: req.url.split('/')[1], matches: [{ id: 1, status: 'IN_PLAY', score: { home: 1, away: 0 } }],
      lastUpdated: iso(Date.now() - (Date.now() < at + 3000 ? 120000 : 0)) }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  at = Date.now() + 1000;
  const manifest = join(dir, 'manifest.json'), output = join(dir, 'evidence');
  const input = schedule(at, origin); await writeFile(manifest, JSON.stringify(input));
  const args = ['scripts/run-score-monitor.py', 'schedule', manifest, output];
  const env = { ...process.env, NODE_BINARY: process.execPath, SCORE_ALERT_URL: origin + '/alerts', SCORE_ALERT_TOKEN: '' };
  const pendingRun = exec('python3', args, { env });
  for (let n = 0; n < 100 && !probes.length; n++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(probes.length);
  await assert.rejects(exec('python3', args, { env }), /Another monitor/);
  const result = await pendingRun;
  assert.equal(JSON.parse(result.stdout).completed, 2);
  assert.equal(probes.length, 12);
  const snapshots = [];
  for (const i of ['01', '02']) {
    const text = await readFile(join(output, `${i}-observations.jsonl`), 'utf8'); snapshots.push(text);
    const rows = text.trim().split('\n').map(JSON.parse).slice(1);
    assert.equal(rows.length, 6);
    assert.ok(rows.every(row => row.startedAt >= row.scheduledAt && row.startedAt - row.scheduledAt < 100), JSON.stringify(rows));
  }
  assert.equal(accepted.size, 2, JSON.stringify(deliveries));
  assert.ok(deliveries.length > accepted.size, 'receiver refusal was retried');
  const delivered = deliveries.length;
  await exec('python3', args, { env });
  assert.equal(probes.length, 12); assert.equal(deliveries.length, delivered);
  assert.equal(await readFile(join(output, '01-observations.jsonl'), 'utf8'), snapshots[0]);
  input.windows[1].fixtureReference = 'Changed schedule'; await writeFile(manifest, JSON.stringify(input));
  await assert.rejects(exec('python3', args, { env }), /Frozen evidence differs/);
  assert.equal(probes.length, 12);
});
