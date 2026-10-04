import test from 'node:test';
import assert from 'node:assert/strict';
import { PutItemCommand } from '@aws-sdk/client-dynamodb';
import { DynamoScoreStore } from '../dynamodb.mjs';
import { fantasyKey } from '../fantasy-store.mjs';
import { client, createTable, deleteTable } from './support.mjs';

async function setup(t) {
  const db = client(), tableName = await createTable(db);
  t.after(async () => { try { await deleteTable(db, tableName); } finally { db.destroy(); } });
  let now = Date.now();
  const clock = () => now, store = new DynamoScoreStore({ client: db, tableName, now: clock });
  const observation = (baseVersion = 0, data = { players: [{ id: 1, name: 'José', minutes: null }] }) =>
    ({ competition: 'PL', season: '2025', kind: 'history', baseVersion, observedAt: clock(), data });
  return { db, tableName, store, observation, clock, advance: ms => { now += ms; } };
}

test('partitioned fantasy data survives adapter restart with source age, Unicode and nulls intact', async t => {
  const { db, tableName, store, observation, clock, advance } = await setup(t);
  const input = observation(0, { players: Array.from({ length: 2000 }, (_, id) => ({ id, name: 'José 😀'.repeat(35), minutes: null })) });
  const lease = await store.claim('writer');
  const manifest = await store.publishFantasy(lease, input);
  assert.ok(manifest.parts.length > 1);
  advance(3600000);
  const reads = [];
  const reader = new DynamoScoreStore({ now: clock, tableName, client: { send: (command, options) => {
    reads.push(command.constructor.name); return db.send(command, options);
  } } });
  const result = await reader.readFantasy('PL', '2025', 'history');
  assert.equal(result.observedAt, input.observedAt); assert.equal(result.collectorEpoch, lease.epoch);
  assert.deepEqual(result.data, input.data);
  result.data.players[0].minutes = 90;
  assert.equal((await reader.readFantasy('PL', '2025', 'history')).data.players[0].minutes, null);
  assert.ok(reads.every(name => name === 'GetItemCommand'));
  assert.equal(await reader.readFantasy('CL', '2025', 'history'), null);
  assert.equal(await reader.readFantasy('PL', '2026', 'history'), null);
  assert.equal(await reader.readFantasy('PL', '2025', 'squads'), null);
});

test('invalid, oversized, stale or conflicting publications cannot replace last good data', async t => {
  const { store, observation, clock } = await setup(t), lease = await store.claim('writer');
  await store.publishFantasy(lease, observation());
  for (const change of [{ observedAt: clock() - 1 }, { observedAt: clock() + 1 }, { baseVersion: 0 },
    { data: [] }, { data: { text: 'x'.repeat(2 * 1024 * 1024) } }, { kind: 'arbitrary' }]) {
    await assert.rejects(store.publishFantasy(lease, { ...observation(1), ...change }));
  }
  assert.equal((await store.readFantasy('PL', '2025', 'history')).version, 1);
});

test('only one concurrent complete dataset can publish for a version', async t => {
  const { store, observation } = await setup(t), lease = await store.claim('writer');
  const results = await Promise.allSettled([1, 2].map(value => store.publishFantasy(lease, observation(0, { value }))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await store.readFantasy('PL', '2025', 'history')).version, 1);
});

test('delayed writer cannot overwrite the replacement collector after takeover', async t => {
  const { db, tableName, store, observation, clock, advance } = await setup(t);
  const old = await store.claim('old'); await store.publishFantasy(old, observation());
  let ready, release;
  const entered = new Promise(resolve => { ready = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const delayed = new DynamoScoreStore({ tableName, now: clock, client: { send: async (command, options) => {
    if (command.constructor.name === 'TransactWriteItemsCommand') { ready(); await gate; }
    return db.send(command, options);
  } } });
  const pending = delayed.publishFantasy(old, observation(1, { owner: 'old' }));
  await entered;
  try {
    advance(30001); const replacement = await store.claim('new');
    await store.publishFantasy(replacement, observation(1, { owner: 'new' }));
  } finally { release(); }
  await assert.rejects(pending, error => error.name === 'TransactionCanceledException');
  const result = await store.readFantasy('PL', '2025', 'history');
  assert.equal(result.collectorEpoch, 2); assert.equal(result.data.owner, 'new');
});

test('whole-read retry prevents mixing old metadata with a concurrent replacement', async t => {
  const { db, tableName, store, observation, clock } = await setup(t), lease = await store.claim('writer');
  await store.publishFantasy(lease, observation());
  let changed = false;
  const reader = new DynamoScoreStore({ tableName, now: clock, client: { send: async (command, options) => {
    const result = await db.send(command, options);
    if (!changed && command.input.Key?.pk.S === fantasyKey('PL', '2025', 'history')) {
      changed = true; await store.publishFantasy(lease, observation(1, { corrected: true }));
    }
    return result;
  } } });
  const result = await reader.readFantasy('PL', '2025', 'history');
  assert.equal(result.version, 2); assert.deepEqual(result.data, { corrected: true });
});

test('missing or corrupted partitions fail closed on a cold reader', async t => {
  const { db, tableName, store, observation, clock } = await setup(t), lease = await store.claim('writer');
  const manifest = await store.publishFantasy(lease, observation());
  await db.send(new PutItemCommand({ TableName: tableName, Item: { pk: { S: `${fantasyKey('PL', '2025', 'history')}#0` },
    digest: { S: manifest.parts[0] }, data: { S: 'corrupted' } } }));
  const reader = new DynamoScoreStore({ tableName, client: db, now: clock });
  await assert.rejects(reader.readFantasy('PL', '2025', 'history'), /partition is unavailable/);
});

test('maximum accepted dataset commits within transaction bounds and can shrink without stale rows leaking', async t => {
  const { store, observation } = await setup(t), lease = await store.claim('writer');
  const data = { text: 'x'.repeat(2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify({ text: '' }))) };
  const manifest = await store.publishFantasy(lease, observation(0, data));
  assert.equal(manifest.bytes, 2 * 1024 * 1024); assert.equal(manifest.parts.length, 16);
  assert.deepEqual((await store.readFantasy('PL', '2025', 'history')).data, data);
  await store.publishFantasy(lease, observation(1, { corrected: true }));
  const next = await store.readFantasy('PL', '2025', 'history');
  assert.equal(next.parts.length, 1); assert.deepEqual(next.data, { corrected: true });
});
