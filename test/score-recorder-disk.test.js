import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, open, readFile, writeFile, rm, statfs, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readLedger } from '../scripts/lib/scoreAlerts.mjs';
import { summarize, waitForSlot } from '../scripts/lib/scoreReliability.mjs';

const exec = promisify(execFile);
test('recorder resumes after real disk exhaustion without rewriting completed evidence', {
  skip: !process.env.SCORE_RECORDER_DISK_TEST_DIR, timeout: 20000,
}, async t => {
  const root = process.env.SCORE_RECORDER_DISK_TEST_DIR;
  const capacity = await statfs(root);
  assert.equal(capacity.type, 0x01021994, 'Requires disposable tmpfs');
  assert.ok(capacity.blocks * capacity.bsize <= 1024 * 1024, 'Refusing to fill more than 1 MiB');
  const dir = await mkdtemp(join(root, 'recorder-disk-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fillerPath = join(dir, 'filler');
  let requests = 0, filled;
  async function fill() {
    const file = await open(fillerPath, 'wx');
    try {
      await assert.rejects(async () => {
        for (let i = 0; i < 257; i++) await file.write(Buffer.alloc(4096));
      }, { code: 'ENOSPC' });
    } finally { await file.close(); }
  }
  const matches = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, status: 'IN_PLAY', score: { home: 0, away: 0 } }));
  const server = createServer(async (req, res) => {
    requests++;
    if (requests === 3) filled = fill();
    try {
      await filled;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ competition: req.url.split('/')[1], matches, lastUpdated: new Date().toISOString() }));
    } catch (error) { res.destroy(error); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const start = Date.now() + 500;
  const plan = { start: new Date(start).toISOString(), end: new Date(start + 6000).toISOString(),
    intervalMs: 1000, origin: `http://127.0.0.1:${server.address().port}`, competitions: ['PL', 'CL'],
    fixtures: ['PL', 'CL'].flatMap(competition => matches.map(m => ({ competition, id: m.id, utcDate: new Date(start).toISOString() }))) };
  const planPath = join(dir, 'plan.json'), ledgerPath = join(dir, 'observations.jsonl');
  await writeFile(planPath, JSON.stringify(plan));
  const script = fileURLToPath(new URL('../scripts/measure-score-reliability.mjs', import.meta.url));
  // The stock Node image has flock but no Python; hold the same inherited OS lock.
  const run = () => exec('sh', ['-c', 'exec 3>"$1"; flock -n 3 || exit 1; export SCORE_MONITOR_LOCK_FD=3; exec "$2" "$3" resume "$4" "$5"',
    'recorder-test', ledgerPath + '.recorder.lock', process.execPath, script, planPath, ledgerPath], { timeout: 12000 });
  await assert.rejects(run(), error => error.code === 1 && /ENOSPC/.test(error.stderr));
  const interrupted = await readFile(ledgerPath), previous = readLedger(interrupted);
  assert.ok(previous.slots.size >= 2, 'First completed slot must survive');
  assert.ok(interrupted.length > previous.complete.length, 'Exercise an actual partial append');
  await unlink(fillerPath);
  await waitForSlot(start + 3000);
  await run();
  const resumedBytes = await readFile(ledgerPath), resumed = readLedger(resumedBytes);
  assert.deepEqual(resumedBytes.subarray(0, previous.complete.length), previous.complete);
  assert.equal(resumedBytes.length, resumed.complete.length, 'Partial tail must be replaced by complete records');
  for (const [key, row] of previous.slots) assert.deepEqual(resumed.slots.get(key), row);
  const report = summarize(plan, [...resumed.slots.values()], start + 6000);
  for (const code of plan.competitions) {
    assert.equal(report.competitions[code].scheduledChecks, 6);
    assert.ok(report.competitions[code].monitorCoveragePercent < 100, 'Disk-full gap must count against coverage');
    assert.ok([...resumed.slots.values()].some(row => row.competition === code && row.scheduledAt >= start + 3000));
  }
  t.diagnostic(JSON.stringify({ preservedRecords: previous.slots.size, discardedPartialBytes: interrupted.length - previous.complete.length,
    recoveredRecords: resumed.slots.size, coverage: Object.fromEntries(plan.competitions.map(code => [code, report.competitions[code].monitorCoveragePercent])) }));
  const beforeRestart = requests;
  await run();
  assert.equal(requests, beforeRestart, 'Completed-window restart must not issue more probes');
  assert.deepEqual(await readFile(ledgerPath), resumedBytes);
});
