import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { DynamoScoreStore } from "../dynamodb.mjs";
import { client, createTable, deleteTable, input, endpoint } from "./support.mjs";

const [mode, file] = process.argv.slice(2);
if (!["write", "verify"].includes(mode) || !file) throw Error("Use write|verify <new-manifest.json>");
const db = client();
try {
  if (mode === "write") {
    const tableName = await createTable(db);
    let now = Date.parse("2026-10-04T12:00:00Z");
    const store = new DynamoScoreStore({ client: db, tableName, now: () => now });
    let lease = await store.claim("before-restart");
    await store.publish(lease, input(now));
    await store.initializeBudget(lease, { dailyLimit: 10, minuteLimit: 300, scoreReserve: 3 }, 0);
    now += 61000;
    lease = await store.claim("before-restart");
    const { permit } = await store.reserve(lease, "scores");
    await store.finish(lease, permit, { ok: false, status: 429 });
    await writeFile(file, JSON.stringify({ tableName, endpoint, now, lease,
      snapshot: await store.read("CL", "2026"), budget: await store.readBudget() }), { flag: "wx", mode: 0o600 });
    console.log("Persisted snapshot, generation, request usage and cooldown; restart the owned local database before verifying.");
  } else {
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.endpoint, endpoint);
    let now = saved.now + 31000;
    const store = new DynamoScoreStore({ client: db, tableName: saved.tableName, now: () => now });
    assert.deepEqual(await store.read("CL", "2026"), saved.snapshot);
    assert.deepEqual(await store.readBudget(), saved.budget);
    let lease = await store.claim("after-restart");
    assert.equal(lease.epoch, saved.lease.epoch + 1);
    assert.equal((await store.reserve(lease, "scores")).reason, "paced");
    await store.publish(lease, input(now, saved.snapshot.version, 2));
    assert.equal((await store.read("CL", "2026")).version, saved.snapshot.version + 1);
    now = saved.budget.blockedUntil + 1;
    lease = await store.claim("after-restart");
    assert.equal((await store.reserve(lease, "scores")).allowed, true);
    assert.equal((await store.readBudget()).used, saved.budget.used + 1);
    await deleteTable(db, saved.tableName);
    console.log("Database restart preserved scores, generation, counted requests and cooldown; takeover resumed without resetting usage.");
  }
} finally { db.destroy(); }
