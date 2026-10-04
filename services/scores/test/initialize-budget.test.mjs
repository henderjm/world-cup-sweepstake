import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInitialization, initializeVerifiedBudget } from '../initialize-budget.mjs';
import { DynamoScoreStore } from '../dynamodb.mjs';
import { client, createTable, deleteTable } from './support.mjs';

const now = Date.parse('2026-10-04T12:00:00Z');
const evidence = () => ({ tableArn: 'arn:aws:dynamodb:eu-west-1:123456789012:table/trial',
  observedAt: now - 1000, consumersStoppedAt: now - 2000, consumersStopped: true,
  evidence: 'trial/cutover-observation', used: 42, uncertainRequests: 3,
  policy: { dailyLimit: 100, minuteLimit: 300, scoreReserve: 20 } });

test('initialization rejects stale, future, unconfirmed, invalid and UTC-boundary evidence', () => {
  assert.equal(validateInitialization(evidence(), now).used, 45);
  for (const patch of [{ observedAt: now - 300001 }, { observedAt: now + 1 },
    { consumersStopped: false }, { consumersStoppedAt: now }, { evidence: '' },
    { uncertainRequests: undefined }, { uncertainRequests: -1 }, { used: 101 },
    { tableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/trial' }])
    assert.throws(() => validateInitialization({ ...evidence(), ...patch }, now));
  const midnight = Date.parse('2026-10-05T00:00:00Z');
  assert.throws(() => validateInitialization({ ...evidence(), observedAt: midnight - 20000 }, midnight - 10000));
  assert.throws(() => validateInitialization({ ...evidence(), observedAt: midnight - 1000 }, midnight + 1000));
});

test('usage is revalidated after lease acquisition and occupied leases prevent writes', async () => {
  let writes = 0, current = now;
  const store = { readBudget: async () => null, claim: async () => { current += 300001; return {}; },
    initializeBudget: async () => { writes++; } };
  await assert.rejects(initializeVerifiedBudget(store, evidence(), () => current), /five minutes/);
  current = now; store.claim = async () => null;
  await assert.rejects(initializeVerifiedBudget(store, evidence(), () => current), /occupied/);
  assert.equal(writes, 0);
});

test('real storage preserves conservative usage across initialization retries and competing operators', async t => {
  const db = client(), tableName = await createTable(db);
  t.after(async () => { try { await deleteTable(db, tableName); } finally { db.destroy(); } });
  const store = new DynamoScoreStore({ client: db, tableName, now: () => now });
  const results = await Promise.allSettled([initializeVerifiedBudget(store, evidence(), () => now), initializeVerifiedBudget(store, evidence(), () => now)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const saved = await store.readBudget();
  assert.equal(saved.used, 45); assert.equal(saved.nextAt, now + 60000);
  await assert.rejects(initializeVerifiedBudget(store, { ...evidence(), used: 0, uncertainRequests: 0 }, () => now), /already exists/);
  assert.deepEqual(await store.readBudget(), saved);
});

test('CLI preview performs no writes; apply verifies the exact table and refuses reset', async t => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { endpoint } = await import('./support.mjs');
  const run = promisify(execFile);
  const db = client(), tableName = await createTable(db), dir = await mkdtemp(join(tmpdir(), 'score-init-'));
  t.after(async () => { try { await deleteTable(db, tableName); } finally { db.destroy(); await rm(dir, { recursive: true }); } });
  const store = new DynamoScoreStore({ client: db, tableName });
  const at = Date.now(), data = { ...evidence(), tableArn: `arn:aws:dynamodb:ddblocal:000000000000:table/${tableName}`,
    observedAt: at, consumersStoppedAt: at - 1000 };
  const path = join(dir, 'evidence.json');
  await writeFile(path, JSON.stringify(data));
  const cli = new URL('../run-initialize-budget.mjs', import.meta.url).pathname;
  const env = { ...process.env, SCORE_DYNAMODB_ENDPOINT: endpoint };
  const preview = await run(process.execPath, [cli, path], { env });
  assert.equal(JSON.parse(preview.stdout).mode, 'preview');
  assert.equal(await store.readBudget(), null);
  await writeFile(path, JSON.stringify({ ...data, tableArn: `arn:aws:dynamodb:eu-west-1:123456789012:table/${tableName}` }));
  await assert.rejects(run(process.execPath, [cli, path, '--apply'], { env }), /identity/);
  assert.equal(await store.readBudget(), null);
  await writeFile(path, JSON.stringify(data));
  const applied = await run(process.execPath, [cli, path, '--apply'], { env });
  assert.equal(JSON.parse(applied.stdout).used, 45);
  await assert.rejects(run(process.execPath, [cli, path, '--apply'], { env }), /already exists/);
  assert.equal((await store.readBudget()).used, 45);
});
