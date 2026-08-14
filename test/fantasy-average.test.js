import test from "node:test";
import assert from "node:assert/strict";

import {
  AVERAGE_NAME,
  AVERAGE_USER_ID,
  averageFixtures,
  averageMember,
  isAverageId,
  medianScore,
  withAverageOpponent,
} from "../src/fantasyAverage.js";
import { roundRobinSchedule } from "../src/draftLogic.js";
import { standingsFromFixtures } from "../src/fantasyGameweek.js";

const members = (ids) => ids.map((id) => ({ userId: id, name: `M${id}` }));

test("medianScore takes the middle value, and the mean of the middle two when even", () => {
  assert.equal(medianScore([10, 30, 20]), 20);
  assert.equal(medianScore([10, 20, 30, 40]), 25);
  assert.equal(medianScore([7]), 7);
});

test("medianScore ignores non-numbers and reports null when nothing is left", () => {
  assert.equal(medianScore([10, null, 20, undefined, "x"]), 15);
  assert.equal(medianScore([]), null);
  assert.equal(medianScore(null), null);
});

// The reason this is a median and not a mean: one huge score must not drag the
// bar everyone else is measured against.
test("one blowout score moves the mean but not the median", () => {
  const ordinary = [40, 45, 50, 55];
  const withBlowout = [40, 45, 50, 200];
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.equal(medianScore(ordinary), medianScore(withBlowout));
  assert.notEqual(mean(ordinary), mean(withBlowout));
});

test("an even league gets no Average opponent at all", () => {
  const four = members([1, 2, 3, 4]);
  const fixtures = roundRobinSchedule([1, 2, 3, 4], 3);
  const scores = fixtures.flatMap((f) => [
    { gameweek: f.gameweek, userId: f.homeUserId, points: 50 },
    { gameweek: f.gameweek, userId: f.awayUserId, points: 50 },
  ]);
  assert.deepEqual(averageFixtures(fixtures, four, scores), []);
  const merged = withAverageOpponent(fixtures, four, scores);
  assert.equal(merged.members.length, 4, "no pseudo-member should be added");
});

test("the unpaired manager in an odd league plays Average, scored as the median of who actually played", () => {
  const five = members([1, 2, 3, 4, 5]);
  // Gameweek 1 of a 5-manager round-robin: two fixtures, one manager unpaired.
  const fixtures = roundRobinSchedule([1, 2, 3, 4, 5], 1);
  assert.equal(fixtures.length, 2, "5 managers pair into 2 fixtures with 1 left over");
  const playedIds = new Set(fixtures.flatMap((f) => [f.homeUserId, f.awayUserId]));
  const byeId = [1, 2, 3, 4, 5].find((id) => !playedIds.has(id));

  // Give the four who played 10/20/30/40 and the unpaired manager 100.
  const points = new Map([...playedIds].map((id, index) => [id, (index + 1) * 10]));
  points.set(byeId, 100);
  const scores = [...points].map(([userId, value]) => ({ gameweek: 1, userId, points: value }));

  const [synth] = averageFixtures(fixtures, five, scores);
  assert.equal(synth.homeUserId, byeId);
  assert.equal(synth.awayUserId, AVERAGE_USER_ID);
  assert.equal(synth.homeScore, 100);
  assert.equal(synth.awayScore, 25, "median of the four who played: (20+30)/2");
});

// The perverse case the exclusion rule exists to prevent.
test("the unpaired manager's own score is excluded from the median they face", () => {
  const three = members([1, 2, 3]);
  const fixtures = [{ gameweek: 1, homeUserId: 1, awayUserId: 2 }];
  const base = [
    { gameweek: 1, userId: 1, points: 40 },
    { gameweek: 1, userId: 2, points: 60 },
  ];

  const modest = averageFixtures(fixtures, three, [...base, { gameweek: 1, userId: 3, points: 10 }]);
  const huge = averageFixtures(fixtures, three, [...base, { gameweek: 1, userId: 3, points: 500 }]);
  assert.equal(modest[0].awayScore, 50);
  assert.equal(huge[0].awayScore, 50, "scoring more must not raise the bar you have to clear");
  assert.equal(huge[0].homeScore, 500);
});

test("a gameweek still being scored produces no Average fixture rather than a result against zero", () => {
  const three = members([1, 2, 3]);
  const fixtures = [{ gameweek: 1, homeUserId: 1, awayUserId: 2 }];
  // No score row for manager 3 yet.
  const noOwnScore = averageFixtures(fixtures, three, [
    { gameweek: 1, userId: 1, points: 40 },
    { gameweek: 1, userId: 2, points: 60 },
  ]);
  assert.deepEqual(noOwnScore, []);
  // No score rows for the pair who played yet.
  const noOthers = averageFixtures(fixtures, three, [{ gameweek: 1, userId: 3, points: 55 }]);
  assert.deepEqual(noOthers, []);
});

// A partial fixture set is not a round-robin, and guessing an opponent for each
// missing manager would be inventing results.
test("more than one unpaired manager in a gameweek yields no Average fixture", () => {
  const five = members([1, 2, 3, 4, 5]);
  const fixtures = [{ gameweek: 1, homeUserId: 1, awayUserId: 2 }]; // 3, 4 and 5 all missing
  const scores = [1, 2, 3, 4, 5].map((userId) => ({ gameweek: 1, userId, points: 50 }));
  assert.deepEqual(averageFixtures(fixtures, five, scores), []);
});

test("withAverageOpponent feeds standingsFromFixtures a ranked Average row", () => {
  const three = members([1, 2, 3]);
  const fixtures = [{ gameweek: 1, homeUserId: 1, awayUserId: 2, homeScore: 40, awayScore: 60 }];
  const scores = [
    { gameweek: 1, userId: 1, points: 40 },
    { gameweek: 1, userId: 2, points: 60 },
    { gameweek: 1, userId: 3, points: 70 }, // beats the median of 50
  ];

  const merged = withAverageOpponent(fixtures, three, scores);
  const table = standingsFromFixtures(merged.fixtures, merged.members);

  const average = table.find((row) => isAverageId(row.userId));
  assert.ok(average, "Average should be a row in the table");
  assert.equal(average.name, AVERAGE_NAME);
  assert.equal(average.played, 1);
  assert.equal(average.losses, 1, "manager 3 outscored the median, so Average lost");
  assert.equal(average.pointsFor, 50);

  const manager3 = table.find((row) => row.userId === 3);
  assert.equal(manager3.wins, 1);
  assert.equal(manager3.played, 1, "the bye no longer costs a manager their gameweek");
});

test("averageMember is labelled as itself and never as a bot", () => {
  const member = averageMember();
  assert.equal(member.userId, AVERAGE_USER_ID);
  assert.equal(member.isAverage, true);
  assert.equal(member.isBot, false);
  assert.equal(isAverageId(member.userId), true);
  assert.equal(isAverageId(1), false);
});

// Across a whole season every manager should end up having played every
// gameweek, which is the entire point: no week is silently forfeited.
test("over a full season no manager in an odd league is ever left without a fixture", () => {
  const ids = [1, 2, 3, 4, 5, 6, 7];
  const seven = members(ids);
  const fixtures = roundRobinSchedule(ids, 38);
  const scores = [];
  for (let gameweek = 1; gameweek <= 38; gameweek += 1) {
    for (const userId of ids) scores.push({ gameweek, userId, points: 40 + ((userId * gameweek) % 25) });
  }

  const merged = withAverageOpponent(fixtures, seven, scores);
  for (let gameweek = 1; gameweek <= 38; gameweek += 1) {
    const playing = new Set(
      merged.fixtures.filter((f) => f.gameweek === gameweek).flatMap((f) => [f.homeUserId, f.awayUserId]),
    );
    for (const userId of ids) {
      assert.ok(playing.has(userId), `manager ${userId} had no fixture in gameweek ${gameweek}`);
    }
  }
});

// The chip only renders if the flag survives the standings computation, and
// standingsFromFixtures builds its rows from scratch rather than spreading the
// member through, so this has to be asserted rather than assumed.
test("standingsFromFixtures carries isAverage through to the row, distinct from isBot", () => {
  const three = members([1, 2, 3]);
  const fixtures = [{ gameweek: 1, homeUserId: 1, awayUserId: 2, homeScore: 40, awayScore: 60 }];
  const scores = [
    { gameweek: 1, userId: 1, points: 40 },
    { gameweek: 1, userId: 2, points: 60 },
    { gameweek: 1, userId: 3, points: 70 },
  ];
  const merged = withAverageOpponent(fixtures, three, scores);
  const table = standingsFromFixtures(merged.fixtures, merged.members);

  const average = table.find((row) => isAverageId(row.userId));
  assert.equal(average.isAverage, true);
  assert.equal(average.isBot, false, "Average must never be labelled a bot");

  for (const row of table.filter((r) => !isAverageId(r.userId))) {
    assert.equal(row.isAverage, false, `${row.name} should not be flagged as Average`);
  }
});
