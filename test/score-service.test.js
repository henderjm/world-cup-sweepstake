import assert from "node:assert/strict";
import test from "node:test";
import { nextSnapshot, scoreFeed, createScoreReadApi } from "../services/scores/snapshots.mjs";
import { ScoreReplayStore } from "./helpers/scoreReplayStore.mjs";

const now = Date.parse("2026-10-13T19:30:00Z");
const fixture = (id, observedAt = now, patch = {}) => ({ observedAt, providerUpdatedAt: null,
  match: { id, utcDate: "2026-10-13T19:00:00Z", homeTeam: `Home ${id}`, awayTeam: `Away ${id}`,
    status: "IN_PLAY", stage: "LEAGUE_STAGE", score: { home: 1, away: 0 }, ...patch } });
const input = patch => ({ competition: "CL", season: "2026", baseVersion: 0,
  scheduleObservedAt: now, fixtures: [fixture(1), fixture(2)], ...patch });
const build = (patch = {}, previous = null, at = now) => nextSnapshot(previous, input(patch), { epoch: 1, now: at });
const table = [{ type: "TOTAL", table: [{ position: 1, team: { name: "Home 1" }, points: 3, playedGames: 1 }] }];

test("expired collectors cannot publish after takeover, including late in-flight responses", () => {
  const store = new ScoreReplayStore(), first = store.claim("first", now);
  store.publish(first, input(), now);
  assert.equal(store.claim("standby", now + 10000), null);
  const second = store.claim("standby", now + 30000);
  assert.equal(second.epoch, 2);
  assert.throws(() => store.publish(first, input({ baseVersion: 1 }), now + 30000), /expired/);
  store.publish(second, input({ baseVersion: 1, fixtures: [fixture(1, now + 30000), fixture(2, now + 30000)] }), now + 30000);
  const current = store.read("CL", "2026");
  assert.equal(current.version, 2);
  assert.equal(current.collectorEpoch, 2);
});

test("expiry without a replacement still rejects writes and renewal cannot resurrect an old token", () => {
  const store = new ScoreReplayStore(), expired = store.claim("owner", now);
  assert.throws(() => store.publish(expired, input(), now + 30000), /expired/);
  const renewed = store.claim("owner", now + 30000);
  assert.equal(renewed.epoch, 2);
  assert.throws(() => store.publish(expired, input(), now + 30000), /expired/);
});

test("out-of-order responses cannot overwrite a newer snapshot even within one lease", () => {
  const previous = build();
  assert.throws(() => build({}, previous), /version conflict/);
  assert.throws(() => build({ baseVersion: 1, fixtures: [fixture(1, now - 1), fixture(2)] }, previous), /older/);
  assert.throws(() => build({ baseVersion: 1, fixtures: [fixture(1, now, { score: { home: 5, away: 0 } }), fixture(2)] }, previous), /older/);
});

test("newer genuine corrections can lower the score and are detached from caller mutation", () => {
  const previous = build(), nextInput = input({ baseVersion: 1,
    fixtures: [fixture(1, now + 1000, { score: { home: 0, away: 0 } }), fixture(2)] });
  const current = nextSnapshot(previous, nextInput, { epoch: 1, now: now + 1000 });
  nextInput.fixtures[0].match.score.home = 9;
  assert.equal(current.fixtures[0].match.score.home, 0);
  assert.equal(previous.fixtures[0].match.score.home, 1);
});

test("partial, empty, duplicate, invalid and oversized writes leave last-good scores intact", () => {
  const store = new ScoreReplayStore(), lease = store.claim("owner", now);
  store.publish(lease, input(), now);
  for (const fixtures of [[], [fixture(1)], [fixture(1), fixture(1)],
    [fixture(1), fixture(2, now, { score: { home: null, away: 0 } })],
    [fixture(1), fixture(2, now + 5000)],
    [fixture(1), fixture(2, now, { extra: "x".repeat(310 * 1024) })]]) {
    assert.throws(() => store.publish(lease, input({ baseVersion: 1, fixtures }), now));
    assert.equal(store.read("CL", "2026").version, 1);
  }
});

test("one fresh game cannot conceal another live game's older observation", () => {
  const snapshot = build({ scheduleObservedAt: now - 120000, fixtures: [fixture(1), fixture(2, now - 120000)] });
  const feed = scoreFeed(snapshot, now);
  assert.equal(feed.stale, true);
  assert.equal(feed.staleAgeMs, 120000);
  assert.equal(feed.lastUpdated, new Date(now - 120000).toISOString());
  assert.equal(feed.snapshot.observations[0].providerUpdatedAt, null);
});

test("viewer reads age existing scores without changing source time, version or publication time", () => {
  const snapshot = build();
  const fresh = scoreFeed(snapshot, now), old = scoreFeed(snapshot, now + 46000);
  assert.equal(fresh.stale, undefined);
  assert.equal(old.stale, true);
  assert.equal(old.lastUpdated, fresh.lastUpdated);
  assert.deepEqual(old.snapshot, fresh.snapshot);
});

test("late-night play stays active across midnight; stale scheduled kickoffs remain visible", () => {
  const midnight = Date.parse("2026-10-14T00:01:00Z");
  const snapshot = build({ fixtures: [fixture(1), fixture(2, now, { status: "TIMED", score: { home: null, away: null } })] });
  assert.equal(scoreFeed(snapshot, midnight).stale, true);
  assert.equal(scoreFeed(snapshot, midnight).matches.length, 2);
});

test("finished history does not determine live age and standings preserve their own observation", () => {
  const snapshot = build({ fixtures: [fixture(1, now - 3600000, { status: "FINISHED" }), fixture(2)],
    standings: { rows: table, observedAt: now - 3600000 } });
  const feed = scoreFeed(snapshot, now);
  assert.equal(feed.stale, undefined);
  assert.equal(feed.standingsDelayed, true);
  assert.equal(feed.standingsUpdatedAt, new Date(now - 3600000).toISOString());
});

test("failed or rolled-back standings never block score publication or replace the saved table age", () => {
  const previous = build({ standings: { rows: table, observedAt: now } });
  for (const standings of [null, { rows: [], observedAt: now }, { rows: table, observedAt: now - 1 },
    { rows: table, observedAt: now + 10000 }]) {
    const current = build({ baseVersion: 1, fixtures: [fixture(1, now + 1000), fixture(2, now + 1000)], standings }, previous, now + 1000);
    const feed = scoreFeed(current, now + 1000);
    assert.equal(current.version, 2);
    assert.equal(feed.stale, undefined);
    assert.equal(feed.standingsDelayed, true);
    assert.equal(feed.standingsUpdatedAt, new Date(now).toISOString());
    assert.deepEqual(feed.standings, table);
  }
});

test("empty discovery, not-yet-collected scores and storage failures are distinct", async () => {
  const empty = build({ fixtures: [] });
  const request = () => new Request("https://scores.test/CL/live");
  for (const [readSnapshot, expected] of [[async () => empty, 200], [async () => null, 503], [async () => { throw Error("private storage details"); }, 503]]) {
    const response = await createScoreReadApi({ readSnapshot, seasons: { CL: "2026" }, now: () => now })(request());
    assert.equal(response.status, expected);
    assert.ok(!(await response.text()).includes("private storage"));
  }
});

test("1,000 concurrent reads require only stored data and leave all versions unchanged", async t => {
  const store = new ScoreReplayStore(), lease = store.claim("collector", now);
  store.publish(lease, input(), now);
  let providerCalls = 0;
  t.mock.method(globalThis, "fetch", async () => { providerCalls++; throw Error("Reads must never fetch upstream"); });
  const api = createScoreReadApi({ readSnapshot: (code, season) => store.read(code, season), seasons: { CL: "2026" }, now: () => now });
  const results = await Promise.all(Array.from({ length: 1000 }, async () => {
    const response = await api(new Request("https://scores.test/CL/live"));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    return (await response.json()).snapshot.version;
  }));
  assert.deepEqual(new Set(results), new Set([1]));
  assert.equal(providerCalls, 0);
});

test("read API cannot publish, switch season or read an unconfigured competition", async () => {
  const api = createScoreReadApi({ readSnapshot: () => { throw Error("Must not read"); }, seasons: { CL: "2026" } });
  for (const [path, method, status] of [["/CL/live", "POST", 405], ["/PL/live", "GET", 404], ["/CL/2027/live", "GET", 404]])
    assert.equal((await api(new Request(`https://scores.test${path}`, { method }))).status, status);
});

test("a storage routing error cannot serve another competition or season", async () => {
  for (const patch of [{ competition: "PL" }, { season: "2025" }]) {
    const api = createScoreReadApi({ readSnapshot: async () => ({ ...build(), ...patch }), seasons: { CL: "2026" }, now: () => now });
    assert.equal((await api(new Request("https://scores.test/CL/live"))).status, 503);
  }
});
