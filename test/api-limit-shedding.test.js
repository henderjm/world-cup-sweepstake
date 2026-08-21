import assert from "node:assert/strict";
import test from "node:test";

import { isLimitRejection } from "../src/apiQuota.js";
import {
  LIMIT_COOLOFF_MS,
  buildQuotaReport,
  createUsageBuffer,
  drainUsage,
  latestQuota,
  markUpstreamLimited,
} from "../src/apiQuotaStore.js";
import { BUDGET_CRITICAL, BUDGET_NORMAL, budgetLevel } from "../src/apiBudget.js";

// The blind spot these guard, recorded in e2e46a8 and left for a decision: a
// rate-limited response carries NO quota headers at all, so the sticky gauge the
// budget guard rail reads kept its last healthy value and reported `normal`
// right through the incident it exists for. The Worker therefore went on
// spending the remainder of a spent allowance on AI analyses and match-drawer
// payloads, which is exactly the allowance getLive and fantasy scoring need.

// -- classifying a refusal ----------------------------------------------------

test("a 429 is a refusal", () => {
  assert.equal(isLimitRejection(429, null), true);
  assert.equal(isLimitRejection("429", null), true);
});

test("a 200 naming an allowance problem is a refusal", () => {
  // The shape that response.ok cannot see, and the reason this exists.
  assert.equal(isLimitRejection(200, { requests: "You have reached the request limit" }), true);
  assert.equal(isLimitRejection(200, { rateLimit: "Too many requests" }), true);
  // Key casing is the provider's business, not ours.
  assert.equal(isLimitRejection(200, { RateLimit: "Too many requests" }), true);
});

test("errors that are not about spend are NOT refusals", () => {
  // Shedding on any error at all would throttle the product over a bad token or
  // an upstream bug, neither of which buys back a single request.
  assert.equal(isLimitRejection(200, { token: "invalid" }), false);
  assert.equal(isLimitRejection(200, { bug: "报告" }), false);
  assert.equal(isLimitRejection(500, { bug: "oops" }), false);
});

test("no errors at all is not a refusal", () => {
  assert.equal(isLimitRejection(200, null), false);
  assert.equal(isLimitRejection(200, undefined), false);
  // API-Football sends an empty ARRAY when nothing is wrong.
  assert.equal(isLimitRejection(200, []), false);
  assert.equal(isLimitRejection(200, {}), false);
  assert.equal(isLimitRejection(200, "nope"), false);
});

// -- the cool-off -------------------------------------------------------------

test("marking a refusal pins the guard rail at its tightest level", () => {
  const buffer = createUsageBuffer();
  assert.equal(budgetLevel(latestQuota(buffer), 1000), BUDGET_NORMAL);

  markUpstreamLimited(buffer, 1000);
  assert.equal(budgetLevel(latestQuota(buffer), 1000), BUDGET_CRITICAL);
});

test("a cold isolate with no reading at all still sheds when refused", () => {
  // The case that matters most: nothing has ever populated the gauge, so there
  // is no reading to lower. latestQuota has to answer with something anyway.
  const buffer = createUsageBuffer();
  assert.equal(latestQuota(buffer), null);
  markUpstreamLimited(buffer, 5_000);
  const gauge = latestQuota(buffer);
  assert.ok(gauge, "a refused isolate must not report an absent gauge");
  assert.equal(gauge.dailyRemaining, undefined);
  assert.equal(budgetLevel(gauge, 5_000), BUDGET_CRITICAL);
});

test("a healthy reading does not rescue a refusal", () => {
  // This is the whole defect: the headers say 7000 of 7500 left, because the
  // refused response carried none and this is the last good reading.
  const buffer = createUsageBuffer();
  buffer.latestQuota = { day: "2026-08-21", dailyLimit: 7500, dailyRemaining: 7000 };
  assert.equal(budgetLevel(latestQuota(buffer), 1000), BUDGET_NORMAL);
  markUpstreamLimited(buffer, 1000);
  assert.equal(budgetLevel(latestQuota(buffer), 1000), BUDGET_CRITICAL);
});

test("the cool-off lapses on its own, so a minute burst recovers", () => {
  const buffer = createUsageBuffer();
  markUpstreamLimited(buffer, 0);
  assert.equal(budgetLevel(latestQuota(buffer), LIMIT_COOLOFF_MS - 1), BUDGET_CRITICAL);
  assert.equal(budgetLevel(latestQuota(buffer), LIMIT_COOLOFF_MS), BUDGET_NORMAL);
  assert.equal(budgetLevel(latestQuota(buffer), LIMIT_COOLOFF_MS + 1), BUDGET_NORMAL);
});

test("a fresh refusal re-arms the cool-off, so a spent key stays pinned", () => {
  // This re-arming is what lets isLimitRejection avoid guessing whether it is
  // looking at a per-minute burst or an exhausted day.
  const buffer = createUsageBuffer();
  markUpstreamLimited(buffer, 0);
  markUpstreamLimited(buffer, LIMIT_COOLOFF_MS - 1);
  assert.equal(budgetLevel(latestQuota(buffer), LIMIT_COOLOFF_MS), BUDGET_CRITICAL);
});

test("an out-of-order refusal never shortens a cool-off", () => {
  const buffer = createUsageBuffer();
  markUpstreamLimited(buffer, 10_000);
  markUpstreamLimited(buffer, 0); // arrives late, would expire sooner
  assert.equal(budgetLevel(latestQuota(buffer), 10_000), BUDGET_CRITICAL);
});

test("the cool-off survives a ledger drain", () => {
  // drainUsage empties what is bound for D1. The gauge is live state the guard
  // rail reads, and blanking it every thirty seconds would fail open as often.
  const buffer = createUsageBuffer();
  markUpstreamLimited(buffer, 1000);
  drainUsage(buffer);
  assert.equal(budgetLevel(latestQuota(buffer), 1000), BUDGET_CRITICAL);
});

test("marking is defensive about junk", () => {
  assert.equal(markUpstreamLimited(null, 1000), 0);
  const buffer = createUsageBuffer();
  markUpstreamLimited(buffer, "not a time");
  assert.equal(budgetLevel(latestQuota(buffer), 1000), BUDGET_NORMAL);
});

// -- fail-open is preserved ---------------------------------------------------

test("an absent gauge is still NORMAL, never CRITICAL", () => {
  // The pre-existing rule, and this change must not erode it: "we could not
  // read the gauge" and "none left" must never look the same.
  assert.equal(budgetLevel(null, 1000), BUDGET_NORMAL);
  assert.equal(budgetLevel({}, 1000), BUDGET_NORMAL);
  assert.equal(budgetLevel({ dailyLimit: null, dailyRemaining: null }, 1000), BUDGET_NORMAL);
  assert.equal(budgetLevel({ dailyLimit: 0, dailyRemaining: 0 }, 1000), BUDGET_NORMAL);
});

test("omitting the clock disables the refusal check rather than throwing", () => {
  // budgetLevel is pure and takes no clock of its own, so a caller that cannot
  // supply one falls back to judging by the gauge alone.
  assert.equal(budgetLevel({ limitedUntil: 9_999_999 }), BUDGET_NORMAL);
  assert.equal(budgetLevel({ dailyLimit: 7500, dailyRemaining: 100 }), BUDGET_CRITICAL);
});

// -- the read side ------------------------------------------------------------

test("/health/quota reports whether we are being refused right now", () => {
  const rows = [{ endpoint: "fixtures", upstream: true, count: 10 }];
  const now = Date.parse("2026-08-21T18:00:00.000Z");

  const healthy = buildQuotaReport({
    rows,
    quota: { dailyLimit: 7500, dailyRemaining: 7000, limitedUntil: 0 },
    now,
  });
  assert.equal(healthy.quota.limited, false);

  const refused = buildQuotaReport({
    rows,
    quota: { dailyLimit: 7500, dailyRemaining: 7000, limitedUntil: now + 60_000 },
    now,
  });
  // The figures still look healthy, because the refused response carried no
  // headers to lower them. This flag is the only thing that says otherwise.
  assert.equal(refused.quota.dailyRemaining, 7000);
  assert.equal(refused.quota.limited, true);

  const lapsed = buildQuotaReport({
    rows,
    quota: { dailyLimit: 7500, dailyRemaining: 7000, limitedUntil: now - 1 },
    now,
  });
  assert.equal(lapsed.quota.limited, false);
});
