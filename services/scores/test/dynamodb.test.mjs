import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { DynamoScoreStore } from "../dynamodb.mjs";
import { createScoreReadApi } from "../snapshots.mjs";
import { client, createTable, deleteTable, input } from "./support.mjs";

async function setup(t) {
  const db = client(), tableName = await createTable(db);
  t.after(async () => { try { await deleteTable(db, tableName); } finally { db.destroy(); } });
  let now = Date.now();
  const clock = () => now;
  const store = new DynamoScoreStore({ client: db, tableName, now: clock });
  return { db, tableName, store, clock, advance: ms => { now += ms; } };
}

test("eight independent processes compete for one collector lease", async t => {
  const { tableName, clock } = await setup(t);
  const leases = await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL("./claim-child.mjs", import.meta.url).pathname, tableName, `child-${i}`, String(clock())],
      { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { error += chunk; });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve(JSON.parse(output)) : reject(Error(error)));
  })));
  assert.equal(leases.filter(Boolean).length, 1);
  assert.equal(leases.find(Boolean).epoch, 1);
});

test("renewal preserves a generation and takeover increments it without deleting state", async t => {
  const { store, clock, advance } = await setup(t);
  const first = await store.claim("first");
  await store.publish(first, input(clock()));
  advance(10000);
  const renewed = await store.claim("first");
  assert.equal(renewed.epoch, first.epoch);
  assert.equal(await store.claim("standby"), null);
  advance(30000);
  const standby = await store.claim("standby");
  assert.equal(standby.epoch, first.epoch + 1);
  await assert.rejects(store.publish(first, input(clock(), 1)), /expired/);
  await store.publish(standby, input(clock(), 1, 2));
  assert.equal((await store.read("CL", "2026")).fixtures[0].match.score.home, 2);
});

test("a delayed transaction from the old collector cannot commit after takeover", async t => {
  const { db, tableName, store, clock, advance } = await setup(t);
  const old = await store.claim("old");
  await store.publish(old, input(clock()));
  let ready, release;
  const entered = new Promise(resolve => { ready = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const slow = new DynamoScoreStore({ tableName, now: clock, client: { send: async (command, options) => {
    if (command.constructor.name === "TransactWriteItemsCommand") { ready(); await gate; }
    return db.send(command, options);
  } } });
  advance(1);
  const pending = slow.publish(old, input(clock(), 1, 9));
  await entered;
  try {
    advance(30000);
    const replacement = await store.claim("replacement");
    await store.publish(replacement, input(clock(), 1, 2));
  } finally { release(); }
  await assert.rejects(pending, error => error.name === "TransactionCanceledException");
  const snapshot = await store.read("CL", "2026");
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.collectorEpoch, 2);
  assert.equal(snapshot.fixtures[0].match.score.home, 2);
});

test("only one concurrent publication based on a given version can commit", async t => {
  const { store, clock, advance } = await setup(t);
  const lease = await store.claim("publisher");
  await store.publish(lease, input(clock()));
  advance(1);
  const results = await Promise.allSettled([2, 3, 4, 5].map(score => store.publish(lease, input(clock(), 1, score))));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal((await store.read("CL", "2026")).version, 2);
});

test("a lost write acknowledgement is reconciled by reading the committed version", async t => {
  const { db, tableName, store, clock, advance } = await setup(t);
  const lease = await store.claim("writer");
  const disconnected = new DynamoScoreStore({ tableName, now: clock, client: { send: async (command, options) => {
    const result = await db.send(command, options);
    if (command.constructor.name === "TransactWriteItemsCommand") throw Error("Write reply lost");
    return result;
  } } });
  await assert.rejects(disconnected.publish(lease, input(clock())), /reply lost/);
  assert.equal((await store.read("CL", "2026")).version, 1);
  await assert.rejects(store.publish(lease, input(clock())), /version conflict/);
  advance(1);
  await store.publish(lease, input(clock(), 1, 2));
  assert.equal((await store.read("CL", "2026")).version, 2);
});

test("storage persists across adapter restart and reads remain isolated by competition and season", async t => {
  const { store, tableName, clock } = await setup(t);
  await store.publish(await store.claim("writer"), input(clock()));
  const connection = client();
  t.after(() => connection.destroy());
  const restored = new DynamoScoreStore({ client: connection, tableName, now: clock });
  assert.deepEqual(await restored.read("CL", "2026"), await store.read("CL", "2026"));
  assert.equal(await restored.read("PL", "2026"), null);
  assert.equal(await restored.read("CL", "2027"), null);
  assert.equal(await restored.claim("new-process"), null);
});

test("malformed, incomplete and oversized publications do not replace last-good scores", async t => {
  const { store, clock } = await setup(t);
  const lease = await store.claim("writer");
  await store.publish(lease, input(clock()));
  const missing = input(clock(), 1); missing.fixtures = [];
  const huge = input(clock() + 1, 1); huge.fixtures[0].match.extra = "x".repeat(310 * 1024);
  const malformed = input(clock() + 1, 1); malformed.fixtures[0].match.score.home = -1;
  for (const next of [missing, huge, malformed]) await assert.rejects(store.publish(lease, next));
  assert.equal((await store.read("CL", "2026")).version, 1);
});

test("database failure never changes into a successful empty feed", async t => {
  const { db, tableName, clock } = await setup(t);
  const store = new DynamoScoreStore({ client: db, tableName: tableName + "_missing", now: clock });
  const api = createScoreReadApi({ readSnapshot: (code, season) => store.read(code, season), seasons: { CL: "2026" }, now: clock });
  assert.equal((await api(new Request("https://scores.test/CL/live"))).status, 503);
});

test("read API uses strongly consistent database reads without any write command", async t => {
  const { db, tableName, store, clock } = await setup(t);
  await store.publish(await store.claim("writer"), input(clock()));
  const commands = [];
  const reader = new DynamoScoreStore({ tableName, now: clock, client: { send: (command, options) => {
    commands.push(command); return db.send(command, options);
  } } });
  const api = createScoreReadApi({ readSnapshot: (code, season) => reader.read(code, season), seasons: { CL: "2026" }, now: clock });
  const responses = await Promise.all(Array.from({ length: 100 }, () => api(new Request("https://scores.test/CL/live"))));
  assert.ok(responses.every(response => response.status === 200));
  assert.equal(commands.length, 100);
  assert.ok(commands.every(command => command.constructor.name === "GetItemCommand" && command.input.ConsistentRead));
  assert.equal((await store.read("CL", "2026")).version, 1);
});
