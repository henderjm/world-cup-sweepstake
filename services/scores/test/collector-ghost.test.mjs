import test from "node:test";
import assert from "node:assert/strict";
import { ScoreCollector, fixtureRows } from "../collector.mjs";
import { nextSnapshot, scoreFeed } from "../snapshots.mjs";

// 2026-10-20: one Champions League fixture vanished upstream at ~15:21 UTC and
// froze the whole CL feed for the evening. Discovery threw "Snapshot lost
// expected fixtures" forever, the id batch holding it threw "did not return
// every requested fixture" for all its siblings, and the stuck fixture pinned
// the feed's lastUpdated. Pure: the real collector and snapshot rules on a
// virtual clock with an in-memory store, no DynamoDB.

const H = 3600000;
const T0 = Date.parse("2026-10-20T00:00:00Z");
const envelope = response => ({ errors: [], results: response.length, paging: { current: 1, total: 1 }, response });

function harness(specs) {
  let now = T0 + 15 * H;
  const snapshots = new Map();
  const state = { hidden: new Set(), alterBatch: null };
  const record = spec => {
    const elapsed = (now - spec.kickoff) / 60000;
    const status = spec.final ? "FT" : elapsed >= 0 ? "1H" : "NS";
    const goals = status === "NS" ? { home: null, away: null } : { home: 0, away: 0 };
    return { fixture: { id: spec.id, date: new Date(spec.kickoff).toISOString(), status: { short: status, elapsed: status === "1H" ? Math.floor(elapsed) : null } },
      league: { id: 2, season: 2026, round: "League Stage - 3" },
      teams: { home: { id: spec.id * 2, name: `Home ${spec.id}` }, away: { id: spec.id * 2 + 1, name: `Away ${spec.id}` } }, goals };
  };
  const lease = { owner: "test", epoch: 1, expiresAt: 0 };
  const store = {
    async claim() { lease.expiresAt = now + 30000; return { ...lease }; },
    async read(code) { return snapshots.get(code) ?? null; },
    async publish(_lease, input) { snapshots.set(input.competition, nextSnapshot(snapshots.get(input.competition), input, { epoch: 1, now })); },
    async readDetailManifest() { return null; },
    async readDetail() { return null; },
    async publishDetail() { throw Error("no detail in this test"); },
    async readFantasyManifest() { return null; },
  };
  const provider = { async request(_lease, path) {
    const url = new URL(path, "https://x.invalid");
    if (url.pathname !== "/fixtures" && url.pathname !== "/standings") return { allowed: false, reason: "test", retryAt: now + H };
    if (url.pathname === "/standings") return { allowed: true, observedAt: now, payload: envelope([{ league: { id: 2, season: 2026, standings: [[1, 2].map(id => ({ rank: id, team: { id, name: `T${id}` }, points: 0, goalsDiff: 0, all: { played: 0, win: 0, draw: 0, lose: 0, goals: { for: 0, against: 0 } } }))] } }]) };
    const ids = url.searchParams.get("ids")?.split("-").map(Number);
    let rows = specs.filter(spec => !state.hidden.has(spec.id) && (!ids || ids.includes(spec.id))).map(record);
    if (ids && state.alterBatch) rows = state.alterBatch(rows);
    return { allowed: true, observedAt: now, payload: envelope(rows) };
  } };
  const collector = new ScoreCollector({ store, provider, seasons: { CL: "2026" }, owner: "test", now: () => now });
  const events = [];
  const run = async until => {
    while (now < until) {
      const event = await collector.step();
      events.push({ ...event, at: now });
      now += event.state === "idle" ? Math.max(1000, Math.min(5000, event.retryAt - now)) : 1000;
    }
  };
  return { state, run, events, feed: () => scoreFeed(snapshots.get("CL"), now), snapshot: () => snapshots.get("CL"), now: () => now };
}

test("a fixture that vanishes upstream is retired and its siblings go live", async () => {
  const kickoff = T0 + 16.75 * H;
  const specs = [
    { id: 1450301, kickoff }, { id: 1450302, kickoff }, { id: 1450399, kickoff },
    { id: 1450303, kickoff: T0 + 19 * H }, { id: 1380001, kickoff: T0 - 80 * 24 * H, final: true },
  ];
  const sim = harness(specs);
  await sim.run(T0 + 15.3 * H);
  sim.state.hidden.add(1450399); // deleted / re-issued upstream
  await sim.run(T0 + 17.25 * H);

  const feed = sim.feed();
  assert.equal(feed.stale, undefined, "the feed stays fresh after kick-off");
  assert.deepEqual(feed.matches.filter(match => match.status === "IN_PLAY").map(match => match.id).sort(), [1450301, 1450302]);
  assert.ok(!feed.matches.some(match => match.id === 1450399), "the ghost is retired");
  assert.ok(feed.matches.some(match => match.id === 1380001), "results are never touched");
  assert.ok(sim.events.some(event => event.retired?.includes(1450399)));
  // Score jobs only: this harness's store refuses detail writes on purpose.
  const failures = sim.events.filter(event => event.state === "failed" && ["discovery", "live", "upcoming", "standings"].includes(event.kind));
  assert.ok(failures.length <= 4, `bounded failures, got ${failures.length}`);
  assert.ok(failures.every(event => event.message), "failures carry a reason");
});

test("a vanished RESULT is never erased: discovery keeps failing rather than lose it", async () => {
  const specs = [{ id: 1380001, kickoff: T0 - 80 * 24 * H, final: true }, { id: 1450301, kickoff: T0 + 19 * H }];
  const sim = harness(specs);
  await sim.run(T0 + 15.1 * H);
  const before = sim.snapshot();
  sim.state.hidden.add(1380001);
  await sim.run(T0 + 15.6 * H);
  assert.ok(sim.snapshot().fixtures.some(row => row.match.id === 1380001));
  assert.ok(sim.events.some(event => event.kind === "discovery" && event.state === "failed" && /lost expected/.test(event.message)));
  assert.ok(sim.snapshot().version >= before.version);
});

test("an empty id batch is a failed read, not twenty vanished matches", async () => {
  const kickoff = T0 + 15.2 * H;
  const sim = harness([{ id: 1, kickoff }, { id: 2, kickoff }]);
  await sim.run(T0 + 15.25 * H);
  sim.state.alterBatch = () => [];
  const failedBefore = sim.events.filter(event => event.kind === "live" && event.state === "failed").length;
  await sim.run(T0 + 15.3 * H);
  assert.ok(sim.events.filter(event => event.kind === "live" && event.state === "failed").length > failedBefore);
  assert.equal(sim.snapshot().fixtures.length, 2);
});

test("a single malformed row is quarantined; a wholly wrong response still fails", () => {
  const job = { competition: "CL", season: "2026" };
  const good = id => ({ fixture: { id, date: "2026-10-20T19:00:00Z", status: { short: "NS" } }, league: { id: 2, season: 2026, round: "League Stage - 3" },
    teams: { home: { id: 1, name: "A" }, away: { id: 2, name: "B" } }, goals: { home: null, away: null } });
  const bad = { ...good(9), fixture: { id: 9, date: "2026-10-20T19:00:00Z", status: { short: "1H", elapsed: 3 } }, goals: { home: null, away: null } };
  const { fixtures, quarantined } = fixtureRows(envelope([good(1), bad, good(2)]), job, T0, 1);
  assert.deepEqual(fixtures.map(row => row.match.id), [1, 2]);
  assert.deepEqual(quarantined, [9]);
  assert.throws(() => fixtureRows(envelope([bad]), job, T0, 1));
  assert.throws(() => fixtureRows(envelope([1, 2, 3, 4].map(id => ({ ...good(id), league: { id: 39, season: 2026 } }))), job, T0, 1));
});

test("the snapshot only accepts a bounded removal of fixtures that never started", () => {
  const row = (id, status, score = null) => ({ match: { id, utcDate: "2026-10-20T19:00:00Z", status, homeTeam: "A", awayTeam: "B", score }, observedAt: T0, providerUpdatedAt: null });
  const previous = nextSnapshot(null, { competition: "CL", season: "2026", baseVersion: 0, scheduleObservedAt: T0,
    fixtures: [row(1, "TIMED"), row(2, "FINISHED", { home: 1, away: 0 }), row(3, "TIMED")] }, { epoch: 1, now: T0 });
  const input = (fixtures, removedIds) => ({ competition: "CL", season: "2026", baseVersion: 1, scheduleObservedAt: T0 + 1, fixtures, removedIds });
  assert.equal(nextSnapshot(previous, input([row(2, "FINISHED", { home: 1, away: 0 }), row(3, "TIMED")], [1]), { epoch: 1, now: T0 + 1 }).fixtures.length, 2);
  assert.throws(() => nextSnapshot(previous, input([row(1, "TIMED"), row(3, "TIMED")], [2]), { epoch: 1, now: T0 + 1 }), /Invalid fixture removal/);
  assert.throws(() => nextSnapshot(previous, input([row(2, "FINISHED", { home: 1, away: 0 })], [1]), { epoch: 1, now: T0 + 1 }), /lost expected/);
});
