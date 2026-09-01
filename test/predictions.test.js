import test from "node:test";
import assert from "node:assert/strict";

import {
  PREDICTION_FANTASY_BONUS,
  PREDICTION_MAX_GOALS,
  PREDICTION_POINTS,
  canPredict,
  predictionFantasyBonus,
  predictionOutcome,
  scoreForMatch,
  scorePrediction,
  summarizePredictions,
  validatePredictionInput,
} from "../src/predictions.js";
import { isFinished } from "../src/format.js";

const KICKOFF = Date.parse("2026-09-12T14:00:00Z");
const match = (overrides = {}) => ({
  id: 1,
  status: "TIMED",
  utcDate: "2026-09-12T14:00:00Z",
  score: { home: null, away: null },
  ...overrides,
});

test("predictionOutcome maps a scoreline to H/D/A", () => {
  assert.equal(predictionOutcome(2, 1), "H");
  assert.equal(predictionOutcome(0, 0), "D");
  assert.equal(predictionOutcome(1, 3), "A");
});

test("scorePrediction: exact beats result beats miss", () => {
  assert.deepEqual(scorePrediction({ homeGoals: 2, awayGoals: 1 }, { homeGoals: 2, awayGoals: 1 }), {
    points: PREDICTION_POINTS.exact,
    exact: true,
    verdict: "exact",
  });
  assert.deepEqual(scorePrediction({ homeGoals: 3, awayGoals: 1 }, { homeGoals: 2, awayGoals: 1 }), {
    points: PREDICTION_POINTS.result,
    exact: false,
    verdict: "result",
  });
  assert.deepEqual(scorePrediction({ homeGoals: 1, awayGoals: 1 }, { homeGoals: 2, awayGoals: 1 }), {
    points: PREDICTION_POINTS.miss,
    exact: false,
    verdict: "miss",
  });
});

// A predicted draw with the wrong scoreline is still the right RESULT. The
// classic trap is comparing goal differences with subtraction and calling 0-0
// vs 3-3 a miss - or 2-1 vs 3-2 (both +1) exact.
test("scorePrediction: wrong-scoreline draw is a result, same goal difference is not exact", () => {
  assert.equal(scorePrediction({ homeGoals: 0, awayGoals: 0 }, { homeGoals: 3, awayGoals: 3 }).verdict, "result");
  const sameDiff = scorePrediction({ homeGoals: 2, awayGoals: 1 }, { homeGoals: 3, awayGoals: 2 });
  assert.equal(sameDiff.verdict, "result");
  assert.equal(sameDiff.exact, false);
});

test("validatePredictionInput accepts whole goals in range and coerces strings", () => {
  assert.deepEqual(validatePredictionInput({ homeGoals: "2", awayGoals: 0 }), {
    ok: true,
    homeGoals: 2,
    awayGoals: 0,
  });
  assert.equal(validatePredictionInput({ homeGoals: 0, awayGoals: PREDICTION_MAX_GOALS }).ok, true);
});

test("validatePredictionInput rejects rather than clamps", () => {
  for (const bad of [
    { homeGoals: -1, awayGoals: 0 },
    { homeGoals: 1.5, awayGoals: 0 },
    { homeGoals: PREDICTION_MAX_GOALS + 1, awayGoals: 0 },
    { homeGoals: "two", awayGoals: 0 },
    { homeGoals: null, awayGoals: 0 },
    {},
    null,
  ]) {
    assert.equal(validatePredictionInput(bad).ok, false, JSON.stringify(bad));
  }
});

test("canPredict: open strictly before kickoff on a pre-match status", () => {
  assert.equal(canPredict(match(), KICKOFF - 1), true);
  assert.equal(canPredict(match({ status: "SCHEDULED" }), KICKOFF - 1), true);
});

test("canPredict FAILS CLOSED: at/after kickoff, live, finished, postponed, unknown kickoff, no match", () => {
  assert.equal(canPredict(match(), KICKOFF), false);
  assert.equal(canPredict(match(), KICKOFF + 1), false);
  assert.equal(canPredict(match({ status: "IN_PLAY" }), KICKOFF - 1), false);
  assert.equal(canPredict(match({ status: "FINISHED" }), KICKOFF - 1), false);
  assert.equal(canPredict(match({ status: "POSTPONED" }), KICKOFF - 1), false);
  assert.equal(canPredict(match({ utcDate: null }), KICKOFF - 1), false);
  assert.equal(canPredict(match({ utcDate: "not a date" }), KICKOFF - 1), false);
  assert.equal(canPredict(null, KICKOFF - 1), false);
});

test("scoreForMatch settles only a finished match with both goals present", () => {
  const prediction = { homeGoals: 2, awayGoals: 1 };
  assert.equal(scoreForMatch(prediction, match()), null);
  assert.equal(scoreForMatch(prediction, match({ status: "IN_PLAY", score: { home: 2, away: 1 } })), null);
  assert.equal(scoreForMatch(prediction, match({ status: "FINISHED", score: { home: null, away: null } })), null);
  assert.deepEqual(scoreForMatch(prediction, match({ status: "FINISHED", score: { home: 2, away: 1 } })), {
    points: PREDICTION_POINTS.exact,
    exact: true,
    verdict: "exact",
  });
  assert.equal(scoreForMatch(prediction, match({ status: "AWARDED", score: { home: 0, away: 3 } })).verdict, "miss");
});

// scoreForMatch keeps its own two-string copy of "finished" rather than
// importing format.js into the Worker path; this pins the two together so a
// new finished status cannot be added to one and not the other.
test("scoreForMatch's finished statuses agree with format.js's isFinished", () => {
  for (const status of ["FINISHED", "AWARDED"]) {
    assert.equal(isFinished(status), true);
    assert.notEqual(scoreForMatch({ homeGoals: 0, awayGoals: 0 }, match({ status, score: { home: 0, away: 0 } })), null);
  }
  for (const status of ["TIMED", "SCHEDULED", "IN_PLAY", "PAUSED", "POSTPONED"]) {
    assert.equal(isFinished(status), false);
    assert.equal(scoreForMatch({ homeGoals: 0, awayGoals: 0 }, match({ status, score: { home: 0, away: 0 } })), null);
  }
});

test("summarizePredictions counts only scored rows and splits exact/result/miss", () => {
  const summary = summarizePredictions([
    { points: 3, exact: true },
    { points: 1, exact: false },
    { points: 0, exact: false },
    { points: null, exact: null }, // not finished yet: not played, not a miss
    null,
  ]);
  assert.deepEqual(summary, { played: 3, exact: 1, result: 1, miss: 1, points: 4 });
});

test("summarizePredictions tolerates empty and missing input", () => {
  assert.deepEqual(summarizePredictions([]), { played: 0, exact: 0, result: 0, miss: 0, points: 0 });
  assert.deepEqual(summarizePredictions(null), { played: 0, exact: 0, result: 0, miss: 0, points: 0 });
});

test("predictionFantasyBonus is per exact prediction and never negative or fractional", () => {
  assert.equal(predictionFantasyBonus(0), 0);
  assert.equal(predictionFantasyBonus(3), 3 * PREDICTION_FANTASY_BONUS);
  assert.equal(predictionFantasyBonus(-2), 0);
  assert.equal(predictionFantasyBonus(1.5), 0);
  assert.equal(predictionFantasyBonus(null), 0);
});
