import assert from "node:assert/strict";
import test from "node:test";

import {
  EASY_STRENGTH_MAX,
  difficultyFor,
  fixtureOutlook,
  HARD_STRENGTH_MIN,
  hasStrengthSignal,
  OUTLOOK_GAMEWEEKS,
} from "../src/fantasyFixtureOutlook.js";

// gameweekOf falls back to the provider matchday for a hand-written list
// without kickoffs, so these toy matches need no utcDate.
const MATCHES = [
  { matchday: 1, homeTeam: "Arsenal", awayTeam: "Chelsea" },
  { matchday: 1, homeTeam: "Man City", awayTeam: "Everton" },
  { matchday: 2, homeTeam: "Chelsea", awayTeam: "Man City" },
  { matchday: 2, homeTeam: "Everton", awayTeam: "Bournemouth" },
  // Arsenal blank in gameweek 2, then a double in gameweek 3.
  { matchday: 3, homeTeam: "Arsenal", awayTeam: "Everton" },
  { matchday: 3, homeTeam: "Bournemouth", awayTeam: "Arsenal" },
];

const STRENGTH = new Map([
  ["Arsenal", 1],
  ["Man City", 0.95],
  ["Chelsea", 0.5],
  ["Everton", 0.3],
  ["Bournemouth", 0.05],
]);

test("fixtureOutlook lists each gameweek's opponents with venue, in window order", () => {
  const outlook = fixtureOutlook({ matches: MATCHES, team: "Chelsea", fromGameweek: 1, strength: STRENGTH });
  assert.equal(outlook.length, OUTLOOK_GAMEWEEKS);
  assert.deepEqual(
    outlook.map((entry) => entry.gameweek),
    [1, 2, 3],
  );
  assert.deepEqual(outlook[0].fixtures, [{ opponent: "Arsenal", isHome: false, difficulty: "hard" }]);
  assert.deepEqual(outlook[1].fixtures, [{ opponent: "Man City", isHome: true, difficulty: "hard" }]);
  assert.deepEqual(outlook[2].fixtures, []); // Chelsea blank in gameweek 3
});

test("fixtureOutlook expresses a blank gameweek as an empty fixtures array and a double as two", () => {
  const outlook = fixtureOutlook({ matches: MATCHES, team: "Arsenal", fromGameweek: 1, strength: STRENGTH });
  assert.equal(outlook[1].fixtures.length, 0); // blank
  assert.equal(outlook[2].fixtures.length, 2); // double
  assert.deepEqual(
    outlook[2].fixtures.map((fixture) => [fixture.opponent, fixture.isHome, fixture.difficulty]),
    [
      ["Everton", true, "easy"],
      ["Bournemouth", false, "easy"],
    ],
  );
});

test("fixtureOutlook drops gameweeks past the end of the schedule instead of calling them blank", () => {
  const outlook = fixtureOutlook({ matches: MATCHES, team: "Arsenal", fromGameweek: 3, strength: STRENGTH });
  assert.equal(outlook.length, 1); // gameweeks 4 and 5 have no fixtures for ANYONE
  assert.equal(outlook[0].gameweek, 3);
});

test("fixtureOutlook returns null with no feed, no team or no anchoring gameweek", () => {
  assert.equal(fixtureOutlook({ matches: [], team: "Arsenal", fromGameweek: 1 }), null);
  assert.equal(fixtureOutlook({ matches: MATCHES, team: null, fromGameweek: 1 }), null);
  assert.equal(fixtureOutlook({ matches: MATCHES, team: "Arsenal", fromGameweek: null }), null);
  assert.equal(fixtureOutlook({ matches: MATCHES, team: "Arsenal", fromGameweek: 99 }), null);
});

test("difficultyFor buckets by the exported thresholds", () => {
  assert.equal(difficultyFor(STRENGTH, "Arsenal"), "hard");
  assert.equal(difficultyFor(STRENGTH, "Chelsea"), "fair");
  assert.equal(difficultyFor(STRENGTH, "Bournemouth"), "easy");
  assert.ok(HARD_STRENGTH_MIN > EASY_STRENGTH_MAX);
});

test("difficultyFor refuses to label an opponent the strength map does not rank", () => {
  // A promoted club absent from the map degrades to unlabelled, never "easy".
  assert.equal(difficultyFor(STRENGTH, "Sunderland"), null);
});

test("a strength map with no ordering yields no difficulty labels at all", () => {
  const neutral = new Map([
    ["Arsenal", 0.5],
    ["Chelsea", 0.5],
    ["Everton", 0.5],
  ]);
  assert.equal(hasStrengthSignal(neutral), false);
  const outlook = fixtureOutlook({ matches: MATCHES, team: "Chelsea", fromGameweek: 1, strength: neutral });
  assert.equal(outlook[0].fixtures[0].difficulty, null);
});

test("hasStrengthSignal requires at least two distinct finite values", () => {
  assert.equal(hasStrengthSignal(null), false);
  assert.equal(hasStrengthSignal(new Map()), false);
  assert.equal(hasStrengthSignal(new Map([["Arsenal", 1]])), false);
  assert.equal(
    hasStrengthSignal(
      new Map([
        ["Arsenal", 1],
        ["Everton", 0.4],
      ]),
    ),
    true,
  );
});

test("fixtureOutlook without any strength map still reports fixtures, unlabelled", () => {
  const outlook = fixtureOutlook({ matches: MATCHES, team: "Everton", fromGameweek: 1 });
  assert.deepEqual(outlook[0].fixtures, [{ opponent: "Man City", isHome: false, difficulty: null }]);
});
