import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, open, readFile, readdir, rm, statfs, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { advanceAlerts, readLedger, readAlertState, saveAlertState, dispatchAlerts } from '../scripts/lib/scoreAlerts.mjs';

// Run only on an explicitly supplied disposable Linux tmpfs, never a host disk.
test('disk exhaustion preserves pending alerts and releases failed temporary writes', {
  skip: !process.env.SCORE_ALERT_DISK_TEST_DIR,
}, async t => {
  const root = process.env.SCORE_ALERT_DISK_TEST_DIR;
  const capacity = await statfs(root);
  assert.equal(capacity.type, 0x01021994, 'Requires disposable tmpfs');
  assert.ok(capacity.blocks * capacity.bsize <= 1024 * 1024, 'Refusing to fill more than 1 MiB');
  const dir = await mkdtemp(join(root, 'alert-disk-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'alerts.json');
  const start = Date.parse('2026-10-04T14:00:00Z');
  const destination = 'http://127.0.0.1/alerts';
  const plan = { start: new Date(start).toISOString(), end: new Date(start + 1000).toISOString(),
    intervalMs: 1000, origin: 'https://example.test', competitions: ['PL', 'CL'], fixtures: [] };
  const ledger = readLedger(Buffer.from(JSON.stringify({ type: 'plan', schema: 1, plan }) + '\n'));
  const state = advanceAlerts(null, ledger, destination, start + 1000);
  assert.equal(state.events.length, 2);
  await saveAlertState(path, state);
  const original = await readFile(path);
  const fillerPath = join(dir, 'filler');
  const filler = await open(fillerPath, 'wx');
  try {
    await assert.rejects(async () => {
      for (let i = 0; i < 257; i++) await filler.write(Buffer.alloc(4096));
    }, { code: 'ENOSPC' });
  } finally { await filler.close(); }
  let calls = 0;
  const fetcher = async (_url, options) => {
    calls++;
    return Response.json({ acceptedEventId: JSON.parse(options.body).id });
  };
  for (let i = 0; i < 3; i++) {
    const resumed = readAlertState(await readFile(path, 'utf8'));
    await assert.rejects(dispatchAlerts(resumed, destination, value => saveAlertState(path, value), {
      now: () => start + 2000, fetcher,
    }), { code: 'ENOSPC' });
    assert.deepEqual(await readFile(path), original, 'Committed delivery history must not change');
    assert.deepEqual((await readdir(dir)).sort(), ['alerts.json', 'filler'], 'Failed writes must not accumulate');
  }
  assert.equal(calls, 0, 'No delivery before durable attempt record');
  await unlink(fillerPath);
  const resumed = readAlertState(await readFile(path, 'utf8'));
  await dispatchAlerts(resumed, destination, value => saveAlertState(path, value), {
    now: () => start + 3000, fetcher,
  });
  const recovered = readAlertState(await readFile(path, 'utf8'));
  assert.deepEqual(recovered.events.map(e => e.id), state.events.map(e => e.id));
  assert.ok(recovered.events.every(e => e.acknowledgedAt === start + 3000 && e.attempts === 1));
  assert.equal(calls, 2);
});
