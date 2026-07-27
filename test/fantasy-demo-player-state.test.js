import assert from "node:assert/strict";
import test from "node:test";

import {
  formMultiplierAt,
  FORM_SWING,
  INJURY_MAX_GAMEWEEKS,
  INJURY_MIN_GAMEWEEKS,
  isInjuredAtGameweek,
  playerFormSeries,
  playerInjuryWindows,
  totalInjuredGameweeks,
} from "../src/fantasyDemoPlayerState.js";

// -- Injuries ---------------------------------------------------------------------

test("playerInjuryWindows is deterministic for the same seed/playerId/gameweek count", () => {
  const first = playerInjuryWindows("season-seed", 42, 38);
  const second = playerInjuryWindows("season-seed", 42, 38);
  assert.deepEqual(first, second);
});

test("playerInjuryWindows never overlaps and stays within 1..totalGameweeks", () => {
  for (let playerId = 1; playerId <= 200; playerId++) {
    const windows = playerInjuryWindows("range-seed", playerId, 38);
    let lastEnd = 0;
    for (const window of windows) {
      assert.ok(window.start >= 1 && window.end <= 38, `window ${JSON.stringify(window)} out of range`);
      assert.ok(window.start <= window.end);
      assert.ok(window.start > lastEnd, "windows must not overlap or touch out of order");
      const span = window.end - window.start + 1;
      assert.ok(span >= INJURY_MIN_GAMEWEEKS && span <= INJURY_MAX_GAMEWEEKS);
      lastEnd = window.end;
    }
  }
});

test("isInjuredAtGameweek is true only strictly within a window's start/end, inclusive", () => {
  const windows = [{ start: 5, end: 7 }];
  assert.equal(isInjuredAtGameweek(windows, 4), false);
  assert.equal(isInjuredAtGameweek(windows, 5), true);
  assert.equal(isInjuredAtGameweek(windows, 6), true);
  assert.equal(isInjuredAtGameweek(windows, 7), true);
  assert.equal(isInjuredAtGameweek(windows, 8), false);
});

test("isInjuredAtGameweek is false for no windows at all", () => {
  assert.equal(isInjuredAtGameweek([], 10), false);
  assert.equal(isInjuredAtGameweek(undefined, 10), false);
});

test("totalInjuredGameweeks sums every window's span", () => {
  assert.equal(totalInjuredGameweeks([{ start: 1, end: 2 }, { start: 10, end: 13 }]), 2 + 4);
  assert.equal(totalInjuredGameweeks([]), 0);
  assert.equal(totalInjuredGameweeks(undefined), 0);
});

test("higher-minutes players are not structurally immune: the injury chance does not depend on tier or position", () => {
  // playerInjuryWindows takes no tier/position argument at all - this test
  // guards the CONTRACT (nothing about the function signature lets a caller
  // even express "this player is protected"), not just today's behaviour.
  assert.equal(playerInjuryWindows.length, 3);
});

test("across a large sample, most players pick up at least one injury across a 38-gameweek season", () => {
  // ~2%/week over 38 weeks is roughly a 55% chance per player of at least one
  // knock; assert a wide, non-flaky band rather than an exact figure.
  let injuredCount = 0;
  const sample = 500;
  for (let playerId = 1; playerId <= sample; playerId++) {
    if (playerInjuryWindows("distribution-seed", playerId, 38).length > 0) injuredCount += 1;
  }
  const rate = injuredCount / sample;
  assert.ok(rate > 0.25 && rate < 0.85, `expected a plausible injury rate, got ${rate}`);
});

// -- Form ---------------------------------------------------------------------------

test("playerFormSeries is deterministic for the same seed/playerId/gameweek count", () => {
  const first = playerFormSeries("form-seed", 7, 38);
  const second = playerFormSeries("form-seed", 7, 38);
  assert.deepEqual(first, second);
});

test("playerFormSeries stays within [-1, 1] and has the right length", () => {
  const series = playerFormSeries("bounds-seed", 99, 38);
  assert.equal(series.length, 38);
  for (const level of series) assert.ok(level >= -1 && level <= 1);
});

test("playerFormSeries produces multi-week streaks, not an independent coin flip every week", () => {
  // A mean-reverting walk should show positive autocorrelation: consecutive
  // weeks land on the SAME side of neutral more often than an independent
  // sequence would (which would only agree ~50% of the time).
  const series = playerFormSeries("streak-seed", 321, 200);
  let sameSign = 0;
  for (let i = 1; i < series.length; i++) {
    if (Math.sign(series[i]) === Math.sign(series[i - 1]) || series[i - 1] === 0) sameSign += 1;
  }
  const rate = sameSign / (series.length - 1);
  assert.ok(rate > 0.6, `expected consecutive weeks to agree in sign well over half the time, got ${rate}`);
});

test("formMultiplierAt centers on 1 and scales with FORM_SWING", () => {
  assert.equal(formMultiplierAt([0, 0.5, -1], 1), 1);
  assert.equal(formMultiplierAt([0, 0.5, -1], 2), 1 + 0.5 * FORM_SWING);
  assert.equal(formMultiplierAt([0, 0.5, -1], 3), 1 - FORM_SWING);
});

test("formMultiplierAt defaults to neutral (1) for a gameweek outside the series", () => {
  assert.equal(formMultiplierAt([], 5), 1);
  assert.equal(formMultiplierAt(undefined, 5), 1);
});
