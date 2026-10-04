import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createReadHandler } from "../read-handler.mjs";
import { DynamoScoreStore } from "../dynamodb.mjs";
import { client, createTable, deleteTable, input, endpoint } from "./support.mjs";

const event = (path = "/CL/live", method = "GET") => ({ version: "2.0", rawPath: path, requestContext: { http: { method } } });

test("gateway handler preserves missing-data, method and route semantics without a provider", async () => {
  let reads = 0;
  const handler = createReadHandler({ store: { read: async () => { reads++; return null; } }, seasons: { CL: 2026 } });
  assert.equal((await handler(event())).statusCode, 503);
  assert.equal((await handler(event("/PL/live"))).statusCode, 404);
  assert.equal((await handler(event("/CL/live", "POST"))).statusCode, 405);
  assert.equal((await handler({})).statusCode, 400);
  assert.equal(reads, 1);
});

test("actual read-service process serves stored scores and recalculates stale age without writes", async t => {
  const db = client(), tableName = await createTable(db);
  t.after(async () => { try { await deleteTable(db, tableName); } finally { db.destroy(); } });
  const now = Date.now(), store = new DynamoScoreStore({ client: db, tableName, now: () => now });
  const old = input(now - 90000);
  await store.publish(await store.claim("writer"), old);
  const child = spawn(process.execPath, [new URL("../run-read-api.mjs", import.meta.url).pathname], {
    env: { ...process.env, API_FOOTBALL_KEY: "", SCORE_TABLE_NAME: tableName, SCORE_SEASONS: "CL:2026", SCORE_DYNAMODB_ENDPOINT: endpoint, SCORE_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode == null) child.kill("SIGKILL"); });
  const exit = once(child, "exit");
  let errors = "", output = "";
  child.stderr.on("data", chunk => { errors += chunk; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`Reader startup timeout: ${errors}`)), 10000);
    child.stdout.on("data", chunk => { output += chunk; if (output.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(output.trim()).port); } });
    child.once("error", reject);
  });
  const response = await fetch(`http://127.0.0.1:${port}/CL/live`);
  assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "no-store");
  const feed = await response.json();
  assert.equal(feed.matches[0].score.home, 1); assert.equal(feed.stale, true); assert.ok(feed.staleAgeMs >= 90000);
  assert.equal((await fetch(`http://127.0.0.1:${port}/CL/live`, { method: "POST" })).status, 405);
  const matchResponse = await fetch(`http://127.0.0.1:${port}/CL/match/900001`);
  assert.equal(matchResponse.status, 200);
  const detail = await matchResponse.json();
  assert.equal(detail.score.home, 1);
  assert.equal(detail.coverage.lineups.state, "missing");
  assert.equal(detail.degraded.length, 4);
  assert.equal(detail.stale, true);
  assert.equal((await fetch(`http://127.0.0.1:${port}/CL/match/999999`)).status, 404);
  assert.equal((await store.read("CL", "2026")).version, 1);
  assert.equal(await store.readBudget(), null);
  child.kill("SIGTERM");
  assert.equal((await exit)[0], 0);
});
