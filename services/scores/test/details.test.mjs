import assert from "node:assert/strict";
import test from "node:test";
import { PutItemCommand } from "@aws-sdk/client-dynamodb";
import { DynamoScoreStore } from "../dynamodb.mjs";
import { detailCoverage, detailSubject, detailKey } from "../details.mjs";
import { client, createTable, deleteTable, input } from "./support.mjs";

async function setup(t) {
  const db = client(), tableName = await createTable(db);
  t.after(async () => { try { await deleteTable(db, tableName); } finally { db.destroy(); } });
  let now = Date.now();
  const clock = () => now;
  const store = new DynamoScoreStore({ client: db, tableName, now: clock });
  const match = input(now).fixtures[0].match;
  const observation = (section = "events", baseVersion = 0, payload = { response: [] }) => ({
    competition: "CL", season: "2026", id: match.id, section, baseVersion, payload,
    observedAt: clock(), subject: detailSubject(match), coverage: "complete",
  });
  return { db, tableName, clock, store, match, observation, advance: ms => { now += ms; } };
}

test("independent sections retain observation age, raw nulls and missing coverage across adapter restart", async t => {
  const { db, tableName, store, clock, observation, advance, match } = await setup(t);
  const lease = await store.claim("writer");
  await store.publishDetail(lease, observation("players", 0, { response: [{ minutes: null }] }));
  const first = clock(); advance(1000);
  await store.publishDetail(lease, observation("events", 1));
  const restarted = new DynamoScoreStore({ client: db, tableName, now: clock });
  const detail = await restarted.readDetail("CL", "2026", match.id);
  assert.equal(detail.sections.players.observedAt, first);
  assert.equal(detail.sections.events.observedAt, clock());
  assert.equal(detail.payloads.players.response[0].minutes, null);
  assert.deepEqual(detail.payloads.events.response, []);
  assert.equal(detailCoverage(detail, match, clock()).lineups.state, "missing");
  detail.payloads.players.response[0].minutes = 99;
  assert.equal((await restarted.readDetail("CL", "2026", match.id)).payloads.players.response[0].minutes, null);
  assert.equal(await store.readDetail("PL", "2026", match.id), null);
  assert.equal(await store.readDetail("CL", "2027", match.id), null);
});

test("failed, oversized, regressing and mismatched publications retain the last observation", async t => {
  const { store, observation, clock, match } = await setup(t);
  const lease = await store.claim("writer");
  await store.publishDetail(lease, observation());
  for (const overrides of [{ payload: {} }, { payload: { response: [], huge: "x".repeat(256 * 1024) } },
    { observedAt: clock() - 1 }, { observedAt: clock() + 1 }, { section: "other" }, { coverage: "unknown" }, { subject: "bad" }]) {
    await assert.rejects(store.publishDetail(lease, { ...observation("events", 1), ...overrides }));
  }
  assert.equal((await store.readDetail("CL", "2026", match.id)).version, 1);
  await assert.rejects(store.publishDetail(lease, observation()), /version conflict/);
});

test("result transition and correction invalidate previously complete terminal detail without invalidating unchanged refreshes", async t => {
  const { store, observation, match, clock } = await setup(t);
  const lease = await store.claim("writer");
  const live = await store.publishDetail(lease, observation());
  const final = { ...match, status: "FINISHED" };
  assert.equal(detailCoverage(live, final, clock()).events.state, "outdated-result");
  const settled = await store.publishDetail(lease, { ...observation("events", 1), subject: detailSubject(final) });
  assert.equal(detailCoverage(settled, { ...final, minute: 95 }, clock()).events.state, "complete");
  const correction = { ...final, score: { home: 0, away: 0 } };
  assert.equal(detailCoverage(settled, correction, clock()).events.state, "outdated-result");
  assert.equal(detailCoverage(settled, final, clock() + 6 * 3600000).events.state, "stale");
  assert.equal(detailCoverage(settled, final, clock() - 1).events.state, "invalid");
  const partial = await store.publishDetail(lease, { ...observation("lineups", 2), coverage: "partial", subject: detailSubject(final) });
  assert.equal(detailCoverage(partial, final, clock()).lineups.state, "partial");
});

test("only one concurrent section write commits against the same manifest version", async t => {
  const { store, observation, match } = await setup(t);
  const lease = await store.claim("writer");
  const results = await Promise.allSettled(["events", "lineups", "players"].map(section => store.publishDetail(lease, observation(section))));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const detail = await store.readDetail("CL", "2026", match.id);
  assert.equal(detail.version, 1);
  assert.equal(Object.keys(detail.payloads).length, 1);
});

test("a delayed old collector cannot publish detail after standby takeover", async t => {
  const { db, tableName, store, observation, advance, clock, match } = await setup(t);
  const lease = await store.claim("old");
  await store.publishDetail(lease, observation());
  let ready, release;
  const entered = new Promise(resolve => { ready = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const delayed = new DynamoScoreStore({ tableName, now: clock, client: { send: async (command, options) => {
    if (command.constructor.name === "TransactWriteItemsCommand") { ready(); await gate; }
    return db.send(command, options);
  } } });
  const pending = delayed.publishDetail(lease, observation("events", 1, { response: ["old"] }));
  await entered;
  try {
    advance(30001);
    const replacement = await store.claim("replacement");
    await store.publishDetail(replacement, observation("events", 1, { response: ["new"] }));
  } finally { release(); }
  await assert.rejects(pending, error => error.name === "TransactionCanceledException");
  const detail = await store.readDetail("CL", "2026", match.id);
  assert.equal(detail.collectorEpoch, 2);
  assert.deepEqual(detail.payloads.events.response, ["new"]);
});

test("a reader retries the complete manifest when a section changes between reads", async t => {
  const { db, tableName, store, observation, clock, match } = await setup(t);
  const lease = await store.claim("writer");
  await store.publishDetail(lease, observation("events", 0, { response: ["old"] }));
  let replaced = false;
  const reader = new DynamoScoreStore({ tableName, now: clock, client: { send: async (command, options) => {
    const result = await db.send(command, options);
    if (!replaced && command.input.Key?.pk.S === detailKey("CL", "2026", match.id)) {
      replaced = true;
      await store.publishDetail(lease, observation("events", 1, { response: ["new"] }));
    }
    return result;
  } } });
  const detail = await reader.readDetail("CL", "2026", match.id);
  assert.equal(detail.version, 2);
  assert.deepEqual(detail.payloads.events.response, ["new"]);
});

test("missing or corrupt section is unavailable, never an empty successful response", async t => {
  const { db, tableName, store, observation, match } = await setup(t);
  const lease = await store.claim("writer");
  await store.publishDetail(lease, observation());
  await db.send(new PutItemCommand({ TableName: tableName, Item: {
    pk: { S: detailKey("CL", "2026", match.id) + "#events" }, data: { S: '{"response":[]}' }, digest: { S: "wrong" },
  } }));
  await assert.rejects(store.readDetail("CL", "2026", match.id), /section is unavailable/);
});
