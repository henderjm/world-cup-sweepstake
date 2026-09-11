import assert from "node:assert/strict";
import test from "node:test";

for (const phase of ["headers", "body"]) {
  test(`a provider stall during ${phase} releases the live route and permits a successful retry`, async t => {
    const { default: worker } = await import(`../worker/worker.js?provider-timeout=${phase}`);
    const deadlines = [];
    t.mock.method(AbortSignal, "timeout", milliseconds => {
      deadlines.push(milliseconds);
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Provider deadline exceeded", "TimeoutError")), 1);
      return controller.signal;
    });
    let stalled = true;
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (url, options) => {
      calls++;
      if (stalled) {
        assert.ok(options.signal instanceof AbortSignal);
        const wait = () => new Promise((resolve, reject) => {
          if (options.signal.aborted) reject(options.signal.reason);
          else options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
        if (phase === "headers") return wait();
        return { ok: true, status: 200, headers: new Headers(), json: wait };
      }
      return Response.json({ errors: [], response: url.includes("/standings") ? [] : [{
        fixture: { id: 900001, date: "2026-09-10T19:00:00Z", status: { short: "FT", elapsed: 90 } },
        league: { id: 2, season: 2026, round: "League Stage - 1" },
        teams: { home: { id: 1, name: "Home" }, away: { id: 2, name: "Away" } },
        goals: { home: 4, away: 0 }, score: { fulltime: { home: 4, away: 0 } },
      }] });
    });
    const env = { API_FOOTBALL_KEY: "test-key", API_FOOTBALL_COMPETITIONS: "CL:2026" };
    const request = () => worker.fetch(new Request("https://test.invalid/CL/live"), env, { waitUntil() {} });
    const failed = await Promise.all([request(), request()]);
    for (const response of failed) {
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), { error: "upstream unavailable" });
    }
    assert.equal(calls, 1, "Concurrent readers must share the same bounded provider request");
    assert.deepEqual(deadlines, [5000]);
    const failedCalls = calls;
    stalled = false;
    const recovered = await request();
    assert.equal(recovered.status, 200);
    const payload = await recovered.json();
    assert.equal(payload.matches[0].status, "FINISHED");
    assert.equal(payload.matches[0].score.home, 4);
    assert.ok(calls > failedCalls, "Timed-out promise or failed response remained cached");
    assert.ok(!payload.stale, "A successful retry stayed degraded");
  });
}

test("a timed-out status refresh serves the recent score with its original age and then recovers", async t => {
  const { default: worker } = await import("../worker/worker.js?provider-timeout=stale-recovery");
  let now = Date.parse("2026-09-10T19:20:00Z");
  t.mock.method(Date, "now", () => now);
  t.mock.method(AbortSignal, "timeout", milliseconds => {
    assert.equal(milliseconds, 5000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Provider deadline exceeded", "TimeoutError")), 1);
    return controller.signal;
  });
  let stall = false;
  let score = 1;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (stall) return new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
    return Response.json({ errors: [], response: url.includes("/standings") ? [] : [{
      fixture: { id: 900002, date: "2026-09-10T19:00:00Z", status: { short: "1H", elapsed: 20 } },
      league: { id: 2, season: 2026, round: "League Stage - 1" },
      teams: { home: { id: 1, name: "Home" }, away: { id: 2, name: "Away" } },
      goals: { home: score, away: 0 }, score: { fulltime: { home: null, away: null } },
    }] });
  });
  const env = { API_FOOTBALL_KEY: "test-key", API_FOOTBALL_COMPETITIONS: "CL:2026" };
  const request = () => worker.fetch(new Request("https://test.invalid/CL/live"), env, { waitUntil() {} });
  const first = await (await request()).json();
  now += 61000;
  stall = true;
  const response = await request();
  assert.equal(response.status, 200);
  const delayed = await response.json();
  assert.equal(delayed.matches[0].score.home, 1);
  assert.equal(delayed.stale, true);
  assert.equal(delayed.staleAgeMs, 61000);
  assert.equal(delayed.lastUpdated, first.lastUpdated);
  stall = false;
  score = 2;
  now += 1000;
  const recovered = await (await request()).json();
  assert.equal(recovered.matches[0].score.home, 2);
  assert.ok(!recovered.stale);
});
