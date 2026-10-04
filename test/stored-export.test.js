import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exportStoredScores } from "../scripts/lib/stored-export.mjs";
import { scoreFeed } from "../services/scores/snapshots.mjs";

const at = Date.now(), origin = "https://export.invalid", competitions = [{ code: "CL", season: "2026" }];
function fixture(id = 900001) { return { id, utcDate: new Date(at - 2 * 3600000).toISOString(), status: "FINISHED",
  homeTeam: "Home", awayTeam: "Away", score: { home: 1, away: 0 } }; }
function feed(matches, version = 1, code = "CL") {
  return scoreFeed({ competition: code, season: "2026", version, collectorEpoch: 1, publishedAt: at, scheduleObservedAt: at,
    fixtures: matches.map(match => ({ match, observedAt: at })), standings: { rows: [], observedAt: null, delayed: true } }, at);
}
function detail(match, version = 1) {
  return { ...match, source: "stored-score-service", competition: "CL", season: "2026",
    home: { name: "Home", lineup: [], bench: [] }, away: { name: "Away", lineup: [], bench: [] },
    goals: match.score.home ? [{ scorer: "Scorer", team: "Home", type: "REGULAR" }] : [], cards: [], subs: [], playerStats: [], degraded: [], stale: false,
    coverage: Object.fromEntries(["fixture", "lineups", "events", "players"].map(name => [name, { state: "complete", observedAt: at - 1000, ageMs: 1000 }])),
    snapshot: { version, collectorEpoch: 1, observedAt: at, detailVersion: version, detailCollectorEpoch: 1 } };
}
async function setup(t, matches = [fixture()]) {
  const rootDir = await mkdtemp(join(tmpdir(), "kickoff-export-test-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const state = { matches, version: 1, partial: false, failed: false, plFailed: false, calls: [], active: 0, peak: 0 };
  const run = comps => exportStoredScores({ rootDir, competitions: comps ?? competitions, origin, now: () => at, log() {}, fetcher: async (url, options) => {
    assert.deepEqual(options.headers, { Accept: "application/json" });
    assert.ok(url.startsWith(origin + "/")); state.calls.push(url);
    if (state.failed || (state.plFailed && url.includes("/PL/"))) return new Response("offline", { status: 503 });
    if (url.endsWith("/live")) return Response.json(feed(state.matches, state.version));
    state.active++; state.peak = Math.max(state.peak, state.active);
    await new Promise(resolve => setTimeout(resolve, 2)); state.active--;
    const match = state.matches.find(match => url.endsWith("/" + match.id));
    const body = detail(match, state.version);
    if (state.partial) { body.coverage.events.state = "partial"; body.degraded = ["/fixtures/events"]; }
    return Response.json(body);
  } });
  const read = async path => JSON.parse(await readFile(join(rootDir, path), "utf8"));
  return { rootDir, state, run, read };
}

test("exports preserve source times and default aliases without including unrelated historical files", async t => {
  const { rootDir, run, read, state } = await setup(t);
  await mkdir(join(rootDir, "CL/matches"), { recursive: true });
  await writeFile(join(rootDir, "CL/matches/old.json"), JSON.stringify({ goals: [{ scorer: "Old season", team: "Away" }] }));
  await run();
  assert.equal((await read("CL/live.json")).lastUpdated, new Date(at).toISOString());
  assert.deepEqual(await read("live.json"), await read("CL/live.json"));
  const tally = await read("CL/scorers.json");
  assert.equal(tally.lastUpdated, new Date(at - 1000).toISOString());
  assert.equal(tally.scorers.length, 1); assert.equal(tally.scorers[0].player, "Scorer");
  assert.deepEqual(await read("scorers.json"), tally); assert.equal(state.calls.length, 2);
});

test("finished-match corrections replace detail and remove an overturned goal from the tally", async t => {
  const { state, run, read } = await setup(t);
  await run(); state.version++; state.matches[0].score.home = 0;
  await run();
  assert.equal((await read("CL/matches/900001.json")).score.home, 0);
  assert.deepEqual((await read("CL/scorers.json")).scorers, []);
});

test("incomplete event coverage keeps the previous dated tally while publishing honest partial detail", async t => {
  const { state, run, read } = await setup(t);
  await run(); const tally = await read("CL/scorers.json");
  state.version++; state.partial = true;
  const result = await run();
  assert.deepEqual(result[0].missingScorerMatches, [900001]);
  assert.deepEqual(await read("CL/scorers.json"), tally);
  assert.equal((await read("CL/matches/900001.json")).coverage.events.state, "partial");
});

test("failed and older score reads cannot replace last-good files; competition failure is isolated", async t => {
  const { state, run, read } = await setup(t);
  state.version = 2; await run(); const before = await read("CL/live.json");
  state.version = 1; assert.ok((await run())[0].error);
  assert.deepEqual(await read("CL/live.json"), before);
  state.failed = true; assert.ok((await run())[0].error);
  assert.deepEqual(await read("CL/live.json"), before);
  state.failed = false; state.plFailed = true; state.version = 3;
  const result = await run([{ code: "PL", season: "2026" }, ...competitions]);
  assert.ok(result[0].error); assert.equal(result[1].matches, 1);
  assert.equal((await read("CL/live.json")).snapshot.version, 3);
});

test("historical detail reads use at most four concurrent requests", async t => {
  const { state, run } = await setup(t, Array.from({ length: 9 }, (_, i) => fixture(900001 + i)));
  const result = await run();
  assert.equal(result[0].details, 9); assert.equal(state.peak, 4);
});

test("stored mode retires direct feeder execution without credentials or a rearm request", async t => {
  const { rootDir } = await setup(t);
  const { spawn } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const guard = join(rootDir, "no-network.mjs"), output = join(rootDir, "github-output");
  await writeFile(guard, 'globalThis.fetch = () => { process.exitCode = 7; throw Error("Forbidden network request"); };');
  const child = spawn(process.execPath, ["--import", pathToFileURL(guard).href, "scripts/feed-live-details.mjs"], {
    env: { ...process.env, SCORE_READ_ORIGIN: origin, API_FOOTBALL_KEY: "synthetic", DETAIL_INGEST_TOKEN: "synthetic", GITHUB_OUTPUT: output },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "", error = "";
  child.stdout.on("data", chunk => { text += chunk; }); child.stderr.on("data", chunk => { error += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0, error); assert.match(text, /shared collector owns/);
  assert.equal(await readFile(output, "utf8"), "follow_up_needed=false\n");
});
