import assert from "node:assert/strict";
import test from "node:test";

import {
  BUDGET_CONSERVE,
  BUDGET_CRITICAL,
  BUDGET_NORMAL,
  allowsAnalysis,
  allowsInteractiveDetail,
  allowsLiveEventDetail,
  budgetLevel,
  matchDetailPlan,
} from "../src/apiBudget.js";

const quota = (dailyRemaining, dailyLimit = 7500) => ({ dailyLimit, dailyRemaining });

test("a comfortable allowance is normal", () => {
  assert.equal(budgetLevel(quota(7500)), BUDGET_NORMAL);
  assert.equal(budgetLevel(quota(1200)), BUDGET_NORMAL); // 16%
});

test("the conserve and critical bands are fractions of the provider's own limit", () => {
  assert.equal(budgetLevel(quota(1125)), BUDGET_CONSERVE); // exactly 15%
  assert.equal(budgetLevel(quota(400)), BUDGET_CONSERVE);
  assert.equal(budgetLevel(quota(375)), BUDGET_CRITICAL); // exactly 5%
  assert.equal(budgetLevel(quota(0)), BUDGET_CRITICAL);

  // A different plan moves the bands with no code change, which is the reason
  // they are fractions rather than call counts.
  assert.equal(budgetLevel(quota(1200, 150000)), BUDGET_CRITICAL);
});

test("an unreadable gauge fails OPEN, never closed", () => {
  // A guard rail that throttles the product because it could not read a gauge
  // is a worse bug than the one it was added to prevent.
  for (const value of [null, undefined, {}, quota(null), quota(undefined), quota(NaN), quota("plenty")]) {
    assert.equal(budgetLevel(value), BUDGET_NORMAL);
  }
  // A zero or negative limit would make every fraction non-positive and pin the
  // Worker at CRITICAL forever, so it is treated as "unknown" too.
  assert.equal(budgetLevel(quota(0, 0)), BUDGET_NORMAL);
  assert.equal(budgetLevel(quota(10, -1)), BUDGET_NORMAL);
});

test("analysis is the first thing shed and the drawer's upstream the last", () => {
  assert.equal(allowsAnalysis(BUDGET_NORMAL), true);
  assert.equal(allowsAnalysis(BUDGET_CONSERVE), false);
  assert.equal(allowsAnalysis(BUDGET_CRITICAL), false);

  assert.equal(allowsInteractiveDetail(BUDGET_CONSERVE), true);
  assert.equal(allowsInteractiveDetail(BUDGET_CRITICAL), false);
});

test("red-card detail survives conserve, because goals never depended on it", () => {
  // Goals, kickoff and full-time are diffed from the batched live-fixture
  // request, so this only ever governs red cards.
  assert.equal(allowsLiveEventDetail(BUDGET_NORMAL), true);
  assert.equal(allowsLiveEventDetail(BUDGET_CONSERVE), true);
  assert.equal(allowsLiveEventDetail(BUDGET_CRITICAL), false);
});

test("the match-detail plan degrades in a fixed order and never to nothing", () => {
  assert.deepEqual(matchDetailPlan(BUDGET_NORMAL), {
    fixture: true,
    lineups: true,
    events: true,
    players: true,
  });
  // Events outlive lineups and player stats: the timeline is what a reader
  // opens the drawer for mid-match.
  assert.deepEqual(matchDetailPlan(BUDGET_CONSERVE), {
    fixture: true,
    lineups: false,
    events: true,
    players: false,
  });
  assert.deepEqual(matchDetailPlan(BUDGET_CRITICAL), {
    fixture: false,
    lineups: false,
    events: false,
    players: false,
  });
});

test("an unknown level is treated as normal, so a typo cannot silently throttle", () => {
  assert.deepEqual(matchDetailPlan("wat"), { fixture: true, lineups: true, events: true, players: true });
  assert.equal(allowsInteractiveDetail(undefined), true);
  assert.equal(allowsLiveEventDetail(undefined), true);
});
