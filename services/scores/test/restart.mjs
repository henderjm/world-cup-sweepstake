import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { DynamoScoreStore } from "../dynamodb.mjs";
import { client, createTable, deleteTable, input, endpoint } from "./support.mjs";

const [mode, file] = process.argv.slice(2);
if (!["write", "verify"].includes(mode) || !file) throw Error("Use write|verify <new-manifest.json>");
const db = client();
try {
  if (mode === "write") {
    const tableName = await createTable(db), now = Date.now();
    const store = new DynamoScoreStore({ client: db, tableName, now: () => now });
    const lease = await store.claim("before-restart");
    await store.publish(lease, input(now));
    await writeFile(file, JSON.stringify({ tableName, endpoint, now, snapshot: await store.read("CL", "2026") }), { flag: "wx", mode: 0o600 });
    console.log("Persisted snapshot and generation; restart the owned local database before verifying.");
  } else {
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.endpoint, endpoint);
    const now = Math.max(Date.now(), saved.now + 31000);
    const store = new DynamoScoreStore({ client: db, tableName: saved.tableName, now: () => now });
    assert.deepEqual(await store.read("CL", "2026"), saved.snapshot);
    const lease = await store.claim("after-restart");
    assert.equal(lease.epoch, saved.snapshot.collectorEpoch + 1);
    await store.publish(lease, input(now, saved.snapshot.version, 2));
    assert.equal((await store.read("CL", "2026")).version, saved.snapshot.version + 1);
    await deleteTable(db, saved.tableName);
    console.log("Database restart preserved scores and generation; takeover and next publication succeeded.");
  }
} finally { db.destroy(); }
