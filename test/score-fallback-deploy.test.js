import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const script = new URL("../scripts/refresh-score-fallback.mjs", import.meta.url).href;
test("deployment refreshes each fallback, preserves newer data and updates the legacy PL copy", async t => {
  const dir = await mkdtemp(join(tmpdir(), "score-fallback-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const now = Date.now();
  const feed = (competition, age) => ({ competition, lastUpdated: new Date(now - age).toISOString(), matches: [{ id: 1 }] });
  const previous = { PL: feed("PL", 120000), CL: feed("CL", 1000) };
  const incoming = { PL: feed("PL", 1000), CL: feed("CL", 120000) };
  for (const code of ["PL", "CL"]) {
    await mkdir(join(dir, "data", code), { recursive: true });
    await writeFile(join(dir, "data", code, "live.json"), JSON.stringify(previous[code]));
  }
  const run = source => spawnSync(process.execPath, ["--input-type=module", "-e", `${source};await import(${JSON.stringify(script)})`], { cwd: dir, encoding: "utf8" });
  const result = run(`let failed = false; globalThis.fetch = async url => { if (url.includes("/PL/") && !failed) { failed = true; throw Error("transient timeout"); } return Response.json((${JSON.stringify(incoming)})[url.split('/').at(-2)]); }`);
  assert.equal(result.status, 0, result.stderr);
  const read = async path => JSON.parse(await readFile(join(dir, "data", path), "utf8"));
  assert.deepEqual(await read("PL/live.json"), incoming.PL);
  assert.deepEqual(await read("live.json"), incoming.PL);
  assert.deepEqual(await read("CL/live.json"), previous.CL);
  const outage = run('globalThis.fetch = async () => new Response("unavailable", { status: 503 })');
  assert.equal(outage.status, 0, outage.stderr);
  assert.match(outage.stderr, /retaining existing data/);
  assert.deepEqual(await read("PL/live.json"), incoming.PL);
  assert.deepEqual(await read("CL/live.json"), previous.CL);
});
