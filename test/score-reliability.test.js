import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { validatePlan, observeFeed, probe, summarize } from "../scripts/lib/scoreReliability.mjs";

const start = Date.parse("2026-10-04T14:00:00Z");
const iso = value => new Date(value).toISOString();
const fixture = { competition: "PL", id: 10, utcDate: iso(start) };
const plan = { start: iso(start), end: iso(start + 180000), intervalMs: 60000,
  origin: "https://example.test", competitions: ["PL"], fixtures: [fixture] };
const match = { id: 10, status: "IN_PLAY", score: { home: 1, away: 0 } };
const body = (at, patch = {}) => ({ competition: "PL", lastUpdated: iso(at), matches: [match], ...patch });
function record(at, payload = body(at), extra = {}) {
  return { type: "probe", competition: "PL", scheduledAt: at, startedAt: at, completedAt: at + 50,
    durationMs: 50, httpStatus: 200, ...observeFeed(payload, "PL", [fixture], at + 50), ...extra };
}
const report = records => summarize(plan, records, start + 180000).competitions.PL;

test("the observation window, competition and fixture identities must be explicit", () => {
  assert.equal(validatePlan(plan).origin, plan.origin);
  for (const patch of [{ end: plan.start }, { intervalMs: 0 }, { fixtures: null }, { competitions: ["PL", "PL"] },
    { origin: "https://secret@example.test" }, { origin: "https://example.test/?key=secret" },
    { fixtures: [fixture, fixture] }, { fixtures: [{ ...fixture, utcDate: "bad" }] },
    { fixtures: [{ ...fixture, competition: "CL" }] }]) assert.throws(() => validatePlan({ ...plan, ...patch }));
});

test("HTTP 200 with an old, missing, future or explicitly stale timestamp never proves freshness", () => {
  for (const [patch, reason] of [[{ lastUpdated: iso(start - 61000) }, "old-source-time"],
    [{ lastUpdated: null }, "missing-source-time"], [{ lastUpdated: iso(start + 5000) }, "future-source-time"],
    [{ stale: true }, "stale-feed"], [{ staleAgeMs: 70000 }, "stale-feed"]]) {
    const r = report([record(start, body(start, patch))]);
    assert.equal(r.freshFixtureChecks, 0);
    assert.equal(r.reasons[reason], 1);
    assert.equal(r.missingChecks, 2);
  }
});

test("sub-second source clock skew is retained as evidence without inventing a stale-score incident", () => {
  const observation = observeFeed(body(start + 34), "PL", [fixture], start);
  assert.equal(observation.reason, null);
  assert.equal(observation.reportedAgeMs, -34);
});

test("missing scheduled probes count against coverage and fixture freshness", () => {
  const r = report([record(start)]);
  assert.equal(r.expectedFixtureChecks, 3);
  assert.equal(r.freshFixtureChecks, 1);
  assert.equal(r.reportedFixtureFreshnessPercent, 100 / 3);
  assert.equal(r.monitorCoveragePercent, 100 / 3);
  assert.equal(r.fixtures[10].longestFailureChecks, 2);
  assert.equal(r.reasons["missing-observation"], 2);
});

test("a missing fixture or an invalid score remains a failure despite a fresh successful feed", () => {
  for (const matches of [[], [{ ...match, score: { home: null, away: 0 } }], [{ ...match, status: "TIMED" }]]) {
    const r = report([record(start, body(start, { matches }))]);
    assert.equal(r.freshFixtureChecks, 0);
    assert.equal(r.usableApiChecks, 0);
  }
  const r = report([record(start, body(start, { stale: true, matches: [{ ...match, status: "TIMED" }] }))]);
  assert.equal(r.usableApiChecks, 0);
});

test("duplicate IDs, wrong competitions and upstream error objects invalidate the feed", () => {
  for (const patch of [{ matches: [match, match] }, { matches: [null] }, { competition: "CL" }, { error: "unavailable" }]) {
    const r = report([record(start, body(start, patch))]);
    assert.equal(r.usableApiChecks, 0);
    assert.equal(r.freshFixtureChecks, 0);
  }
});

test("only a fresh validated final result can retire a fixture; live corrections reopen it", () => {
  const final = body(start, { matches: [{ ...match, status: "FINISHED" }] });
  assert.equal(report([record(start, final)]).expectedFixtureChecks, 1);
  assert.equal(report([record(start, { ...final, stale: true })]).expectedFixtureChecks, 3);
  const r = report([record(start, final), record(start + 60000, body(start + 60000, {
    matches: [{ ...match, score: { home: 0, away: 0 } }],
  }))]);
  assert.equal(r.expectedFixtureChecks, 3);
  assert.equal(r.freshFixtureChecks, 2);
});

test("halftime, extra time, penalties and interruptions remain expected", () => {
  for (const status of ["PAUSED", "EXTRA_TIME", "PENALTY_SHOOTOUT", "BREAK"]) {
    const r = report([record(start, body(start, { matches: [{ ...match, status }] }))]);
    assert.equal(r.expectedFixtureChecks, 3);
    assert.equal(r.freshFixtureChecks, 1);
  }
});

test("no active fixtures means no freshness percentage, never an invented 100 percent", () => {
  const r = summarize({ ...plan, fixtures: [] }, [record(start)], start + 180000).competitions.PL;
  assert.equal(r.reportedFixtureFreshnessPercent, null);
  assert.equal(r.expectedFixtureChecks, 0);
  assert.equal(r.feedReasons["missing-observation"], 2);
});

test("the real fetch aborts a stalled response body within the probe deadline", async t => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"competition":"PL",');
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const r = await probe({ ...plan, intervalMs: 1000, origin: `http://127.0.0.1:${server.address().port}` }, "PL", Date.now());
  assert.equal(r.httpStatus, 200);
  assert.equal(r.reason, "timeout");
  assert.ok(r.durationMs >= 900 && r.durationMs < 5000, `unexpected deadline ${r.durationMs}ms`);
});

test("future slots and pre-kickoff fixtures do not inflate the measured denominator", () => {
  const future = { ...fixture, utcDate: iso(start + 60000) };
  const r = summarize({ ...plan, fixtures: [future] }, [record(start)], start + 500).competitions.PL;
  assert.equal(r.scheduledChecks, 1);
  assert.equal(r.expectedFixtureChecks, 0);
});

test("late observations cannot repair missed slots or retire expected matches", () => {
  const r = report([record(start, body(start + 70000, { matches: [{ ...match, status: "FINISHED" }] }),
    { startedAt: start + 70000, completedAt: start + 70050, durationMs: 50 })]);
  assert.equal(r.freshFixtureChecks, 0);
  assert.equal(r.usableApiChecks, 0);
  assert.equal(r.expectedFixtureChecks, 3);
  assert.equal(r.reasons["late-observation"], 1);
});

test("failed request durations remain in latency percentiles and duplicate observations are rejected", () => {
  const r = report([record(start), record(start + 60000, body(start + 60000),
    { reason: "timeout", httpStatus: null, completedAt: start + 68000, durationMs: 8000, fixtures: [] })]);
  assert.equal(r.responseLatencyP95Ms, 8000);
  assert.throws(() => report([record(start), record(start)]), /duplicate/);
  assert.throws(() => report([record(start + 1)]), /out-of-plan/);
});

test("CL failures and an individually missing match cannot disappear behind healthy PL reads", () => {
  const mixed = { ...plan, competitions: ["PL", "CL"], fixtures: [fixture,
    { ...fixture, competition: "CL", id: 20 }, { ...fixture, competition: "CL", id: 21 }] };
  const clBody = body(start, { competition: "CL", matches: [{ ...match, id: 20 }] });
  const clRow = { ...record(start), competition: "CL",
    ...observeFeed(clBody, "CL", mixed.fixtures.filter(f => f.competition === "CL"), start + 50) };
  const r = summarize(mixed, [record(start), clRow], start + 500).competitions;
  assert.equal(r.PL.reportedFixtureFreshnessPercent, 100);
  assert.equal(r.CL.reportedFixtureFreshnessPercent, 50);
  assert.equal(r.CL.fixtures[21].reportedFreshnessPercent, 0);
});

test("probe records refusals, malformed JSON and body timeouts without retaining response contents", async () => {
  const options = { now: () => start + 100 };
  const refused = await probe(plan, "PL", start, { ...options, fetcher: async () => new Response("secret", { status: 429 }) });
  assert.equal(refused.reason, "http-429");
  assert.ok(!JSON.stringify(refused).includes("secret"));
  const malformed = await probe(plan, "PL", start, { ...options, fetcher: async () => new Response("not json") });
  assert.equal(malformed.reason, "invalid-json");
  const hung = await probe({ ...plan, intervalMs: 10 }, "PL", start, {
    ...options, fetcher: async (_url, { signal }) => ({ status: 200, ok: true,
      json: () => new Promise((_, reject) => signal.addEventListener("abort", () => reject(Error("aborted")))) }),
  });
  assert.equal(hung.reason, "timeout");
});

async function command(args) {
  const child = spawn(process.execPath, ["scripts/measure-score-reliability.mjs", ...args]);
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  return { code, stdout, stderr };
}

test("CLI records real HTTP reads, retains the plan and reconstructs missing observations after interruption", async t => {
  const dir = await mkdtemp(join(tmpdir(), "score-reliability-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const server = createServer((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body(Date.now()))); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const at = Date.now() + 1000;
  const localPlan = { ...plan, start: iso(at), end: iso(at + 1500), intervalMs: 1000,
    origin: `http://127.0.0.1:${server.address().port}`, fixtures: [{ ...fixture, utcDate: iso(at) }] };
  const planPath = join(dir, "plan.json"), logPath = join(dir, "ledger.jsonl");
  await writeFile(planPath, JSON.stringify(localPlan));
  const recorded = await command(["record", planPath, logPath]);
  assert.equal(recorded.code, 0, recorded.stderr);
  assert.equal(JSON.parse(recorded.stdout).competitions.PL.freshFixtureChecks, 2);
  const lines = (await readFile(logPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 3);
  assert.equal((await command(["record", planPath, logPath])).code, 1, "never overwrite evidence");
  await writeFile(logPath, lines[0] + "\n" + lines[1] + '\n{"interrupted":');
  const recovered = await command(["report", logPath]);
  assert.equal(recovered.code, 0, recovered.stderr);
  const r = JSON.parse(recovered.stdout).competitions.PL;
  assert.equal(r.scheduledChecks, 2);
  assert.equal(r.completedChecks, 1);
  assert.equal(r.freshFixtureChecks, 1);
  assert.equal(r.missingChecks, 1);
  await writeFile(logPath, lines[0] + "\ninvalid complete record\n");
  assert.equal((await command(["report", logPath])).code, 1, "completed corrupt lines must not be silently ignored");
  await writeFile(planPath, JSON.stringify({ ...localPlan, origin: "https://goon-squad-data.gs-wc.workers.dev" }));
  const unsafe = await command(["record", planPath, join(dir, "unsafe.jsonl")]);
  assert.equal(unsafe.code, 1);
  assert.match(unsafe.stderr, /protect provider quota/);
});
