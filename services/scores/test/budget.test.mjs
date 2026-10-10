import assert from "node:assert/strict";
import test from "node:test";
import { initialBudget, reserveRequest, finishRequest } from "../budget.mjs";

const start = Date.parse("2026-10-04T12:00:00Z");
const policy = { dailyLimit: 10, minuteLimit: 300, scoreReserve: 3 };
const initial = used => initialBudget(policy, used, start);
const reserve = (state, now, priority = "scores") => reserveRequest(state, { now, priority, id: "request", admissionTimeoutMs: 3000 });
const finish = (result, outcome, now) => finishRequest(result.next, result.permit, outcome, now);

test("cold budgets require verified usage, and startup drains the previous minute", () => {
  assert.throws(() => initial(undefined));
  assert.throws(() => reserve(null, start));
  assert.throws(() => reserve({ ...initial(0), used: null }, start + 60000), /Invalid stored/);
  assert.deepEqual(reserve(initial(0), start), { allowed: false, reason: "paced", retryAt: start + 60000 });
  assert.equal(reserve(initial(0), start + 60000).allowed, true);
});

test("optional data cannot consume the score reserve, and scores obey the hard daily cap", () => {
  assert.equal(reserve(initial(7), start + 60000, "supplementary").reason, "score-reserve");
  const admitted = reserve(initial(9), start + 60000);
  assert.equal(admitted.next.used, 10);
  const finished = finish(admitted, { ok: true }, start + 60001);
  assert.equal(reserve(finished, start + 70000).reason, "daily-limit");
});

test("a crash retains the counted request and its full deadline plus pacing", () => {
  const admitted = reserve(initial(0), start + 60000);
  assert.equal(reserve(admitted.next, admitted.permit.expiresAt).reason, "paced");
  const recovered = reserve(admitted.next, admitted.next.nextAt);
  assert.equal(recovered.next.used, 2);
});

test("successful calls are spread across seconds and minutes without fixed-window bursts", () => {
  let state = initialBudget({ dailyLimit: 1000, minuteLimit: 450, scoreReserve: 0 }, 0, start);
  const sent = [];
  for (let i = 0; i < 500; i++) {
    const at = state.nextAt;
    const admitted = reserve(state, at);
    assert.equal(admitted.allowed, true);
    sent.push(at);
    state = finish(admitted, { ok: true }, at);
  }
  for (const at of sent) {
    assert.ok(sent.filter(value => value >= at && value < at + 1000).length <= 7);
    assert.ok(sent.filter(value => value >= at && value < at + 60000).length <= 450);
  }
});

test("HTTP 200 allowance errors and 429s impose shared cooldown and honor Retry-After", () => {
  for (const outcome of [{ status: 200, errors: { requests: "exhausted" } }, { status: 429 },
    { status: 200, errors: { rateLimit: "slow down" } }, { status: 200, headers: new Headers({ "X-RateLimit-Remaining": "0" }) }]) {
    const admitted = reserve(initial(0), start + 60000);
    const state = finish(admitted, { ok: false, ...outcome }, start + 60001);
    assert.equal(state.blockedUntil, start + 120001);
  }
  for (const retry of ["120", new Date(start + 180001).toUTCString()]) {
    const state = finish(reserve(initial(0), start + 60000), { ok: false, status: 503, headers: new Headers({ "retry-after": retry }) }, start + 60001);
    assert.ok(state.blockedUntil >= start + 180000);
  }
});

test("provider quota can reduce allowance but higher or missing readings never refund attempts", () => {
  const admitted = reserve(initial(0), start + 60000);
  const state = finish(admitted, { ok: true, headers: new Headers({ "x-ratelimit-requests-limit": "100", "x-ratelimit-requests-remaining": "92" }) }, start + 60001);
  assert.equal(state.used, 8);
  const again = reserve(state, state.nextAt);
  const fresh = finish(again, { ok: true, headers: new Headers({ "x-ratelimit-requests-remaining": "100" }) }, state.nextAt + 1);
  assert.equal(fresh.used, 9);
  const reduced = finish(admitted, { ok: false, headers: new Headers({ "x-ratelimit-requests-limit": "2", "x-ratelimit-requests-remaining": "0", "X-RateLimit-Limit": "10" }) }, start + 60001);
  assert.equal(reduced.used, 2);
  assert.equal(reduced.policy.dailyLimit, 2);
  assert.equal(reduced.policy.minuteLimit, 10);
  assert.equal(reserve(reduced, start + 70000).reason, "daily-limit");
});

test("failures back off, and UTC rollover preserves pacing without carrying daily usage", () => {
  let state = initial(0);
  for (const delay of [1000, 2000, 4000]) {
    const at = Math.max(state.nextAt, state.blockedUntil);
    state = finish(reserve(state, at), { ok: false, status: 500 }, at);
    assert.equal(state.blockedUntil, at + delay);
  }
  const midnight = Date.parse("2026-10-05T00:00:00Z");
  assert.equal(reserve(state, midnight - 8000).reason, "day-boundary");
  const nextDay = reserve(initial(10), midnight);
  assert.equal(nextDay.next.used, 1);
  assert.throws(() => reserve(state, start), /clock moved backwards/);
  assert.throws(() => finishRequest(nextDay.next, { id: "other" }, { ok: true }, midnight), /replaced/);
});

test("current match details have bounded access after optional data is stopped", () => {
  assert.equal(reserve(initial(7), start + 60000, "match-detail").allowed, true);
  assert.equal(reserve(initial(8), start + 60000, "match-detail").reason, "score-reserve");
  assert.equal(reserve(initial(8), start + 60000, "scores").allowed, true);
  assert.equal(reserve(initial(10), start + 60000, "match-detail").allowed, false);
});
