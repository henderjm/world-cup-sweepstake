import assert from "node:assert/strict";
import test from "node:test";
import { DeleteItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { DynamoScoreStore } from "../dynamodb.mjs";
import { snapshotLayout } from "../layout.mjs";
import { createReadHandler } from "../read-handler.mjs";
import { client, createTable, deleteTable, input } from "./support.mjs";

async function setup(t) {
  const db = client(), tableName = await createTable(db);
  t.after(async () => { try { await deleteTable(db, tableName); } finally { db.destroy(); } });
  let now = Date.parse("2026-10-13T19:30:00Z");
  const clock = () => now, commands = [];
  const store = new DynamoScoreStore({ tableName, now: clock, client: { send: (command, options) => { commands.push(command); return db.send(command, options); } } });
  return { db, tableName, store, commands, clock, lease: await store.claim("writer"), advance: () => { now++; } };
}

function season(now) {
  const snapshot = input(now);
  snapshot.fixtures = Array.from({ length: 1000 }, (_, i) => ({ ...snapshot.fixtures[0], match: {
    ...snapshot.fixtures[0].match, id: 900001 + i, status: i < 20 ? "IN_PLAY" : "FINISHED",
    score: { ...snapshot.fixtures[0].match.score },
    homeTeam: `Home team ${i}`, awayTeam: `Away team ${i}`, venue: "Venue ".repeat(80),
  } }));
  return snapshot;
}

test("a 1,000-fixture season fits bounded parts and a hot update writes only its part and manifest", async t => {
  const { db, tableName, store, lease, commands, clock, advance } = await setup(t);
  const data = season(clock());
  await store.publish(lease, data);
  const snapshot = await store.read("CL", "2026");
  const layout = snapshotLayout(snapshot);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) > 300 * 1024);
  assert.ok(Object.values(layout.parts).every(part => Buffer.byteLength(part.data) <= 256 * 1024));
  assert.ok(Buffer.byteLength(JSON.stringify(layout.manifest)) <= 4096);
  const reads = [];
  const reader = new DynamoScoreStore({ tableName, now: clock, client: { send: async (command, options) => {
    const result = await db.send(command, options);
    reads.push({ key: command.input.Key.pk.S, bytes: Buffer.byteLength(result.Item.manifest?.S ?? result.Item.data?.S ?? "") });
    return result;
  } } });
  await reader.read("CL", "2026");
  const coldBytes = reads.reduce((total, read) => total + read.bytes, 0);
  reads.length = 0;
  const warm = await reader.read("CL", "2026");
  assert.equal(reads.length, 1);
  assert.ok(reads[0].bytes < coldBytes / 100);
  warm.fixtures[0].match.score.home = 99;
  assert.equal((await reader.read("CL", "2026")).fixtures[0].match.score.home, 1);
  advance();
  const next = { ...data, baseVersion: 1, fixtures: structuredClone(data.fixtures) };
  next.fixtures[0].observedAt = clock(); next.fixtures[0].match.score.home = 2;
  commands.length = 0;
  await store.publish(lease, next);
  const transaction = commands.find(command => command.constructor.name === "TransactWriteItemsCommand");
  assert.equal(transaction.input.TransactItems.length, 3);
  reads.length = 0;
  const updated = await reader.read("CL", "2026");
  assert.equal(updated.version, 2); assert.equal(updated.fixtures[0].match.score.home, 2);
  assert.equal(reads.length, 2);
  assert.deepEqual(updated.fixtures.slice(1), snapshot.fixtures.slice(1));
  t.diagnostic(JSON.stringify({ fixtureCount: snapshot.fixtures.length, snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)),
    manifestBytes: Buffer.byteLength(JSON.stringify(layout.manifest)), coldBytes, changedReadBytes: reads.reduce((total, read) => total + read.bytes, 0),
    parts: Object.keys(layout.parts).length, largestPartBytes: Math.max(...Object.values(layout.parts).map(part => Buffer.byteLength(part.data))) }));
});

test("a publication between manifest and part reads cannot mix score versions", async t => {
  const { db, tableName, store, lease, clock, advance } = await setup(t);
  const first = input(clock());
  first.fixtures.push({ ...first.fixtures[0], match: { ...first.fixtures[0].match, id: 900002 } });
  await store.publish(lease, first);
  let manifestReads = 0;
  const reader = new DynamoScoreStore({ tableName, now: clock, client: { send: async (command, options) => {
    const result = await db.send(command, options);
    if (command.input.Key.pk.S === "SCORE#CL#2026" && ++manifestReads === 1) {
      advance();
      const next = { ...first, baseVersion: 1, fixtures: first.fixtures.map(row => ({ ...row, observedAt: clock(),
        match: { ...row.match, score: { home: 2, away: 0 } } })) };
      await store.publish(lease, next);
    }
    return result;
  } } });
  const read = await reader.read("CL", "2026");
  assert.equal(manifestReads, 2);
  assert.equal(read.version, 2);
  assert.deepEqual(read.fixtures.map(row => row.match.score.home), [2, 2]);
});

test("a missing or corrupted partition fails closed through the read handler", async t => {
  const { db, tableName, store, lease, clock } = await setup(t);
  await store.publish(lease, input(clock()));
  const snapshot = await store.read("CL", "2026"), { parts } = snapshotLayout(snapshot);
  const part = Object.keys(parts).find(name => name !== "T"), Key = { pk: { S: `SCORE#CL#2026#${part}` } };
  await db.send(new DeleteItemCommand({ TableName: tableName, Key }));
  const read = () => createReadHandler({ store: new DynamoScoreStore({ client: db, tableName, now: clock }), seasons: { CL: 2026 }, now: clock })
    ({ version: "2.0", rawPath: "/CL/live", requestContext: { http: { method: "GET" } } });
  assert.equal((await read()).statusCode, 503);
  await db.send(new PutItemCommand({ TableName: tableName, Item: { ...Key, digest: { S: parts[part].digest }, data: { S: "[]" } } }));
  assert.equal((await read()).statusCode, 503);
});

test("oversized fixture partitions cannot partially replace the current version", async t => {
  const { store, lease, clock, advance } = await setup(t);
  await store.publish(lease, input(clock()));
  advance();
  const tooLarge = input(clock(), 1);
  tooLarge.fixtures = Array.from({ length: 12 }, (_, i) => ({ ...tooLarge.fixtures[0], match: {
    ...tooLarge.fixtures[0].match, id: 900001 + i * 8, extra: "x".repeat(24 * 1024),
  } }));
  await assert.rejects(store.publish(lease, tooLarge), /partition exceeds/);
  assert.equal((await store.read("CL", "2026")).version, 1);
});

test("moving a fixture from active to completed preserves a coherent result without unbounded record keys", async t => {
  const { store, lease, clock, advance } = await setup(t);
  await store.publish(lease, input(clock()));
  advance();
  const final = input(clock(), 1, 2); final.fixtures[0].match.status = "FINISHED";
  await store.publish(lease, final);
  const read = await store.read("CL", "2026");
  assert.equal(read.fixtures.length, 1);
  assert.equal(read.fixtures[0].match.score.home, 2);
  assert.equal(read.fixtures[0].match.status, "FINISHED");
  assert.ok(Object.keys(snapshotLayout(read).parts).every(name => !name.startsWith("H")));
});
