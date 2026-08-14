import test from "node:test";
import assert from "node:assert/strict";

import { formatRecord, headToHeadFor, headToHeadRecords } from "../src/fantasyHeadToHead.js";
import { AVERAGE_USER_ID, withAverageOpponent } from "../src/fantasyAverage.js";
import { roundRobinSchedule } from "../src/draftLogic.js";

const members = (ids) => ids.map((id) => ({ userId: id, name: `M${id}` }));

test("a win for one manager is a loss for the other, from the same fixture", () => {
  const grid = headToHeadRecords([{ gameweek: 1, homeUserId: 1, awayUserId: 2, homeScore: 60, awayScore: 40 }], [1, 2]);
  assert.deepEqual(grid.get(1).get(2), {
    opponentId: 2,
    played: 1,
    wins: 1,
    draws: 0,
    losses: 0,
    pointsFor: 60,
    pointsAgainst: 40,
  });
  assert.deepEqual(grid.get(2).get(1), {
    opponentId: 1,
    played: 1,
    wins: 0,
    draws: 0,
    losses: 1,
    pointsFor: 40,
    pointsAgainst: 60,
  });
});

test("repeated meetings accumulate rather than overwrite", () => {
  const fixtures = [
    { gameweek: 1, homeUserId: 1, awayUserId: 2, homeScore: 60, awayScore: 40 },
    { gameweek: 20, homeUserId: 2, awayUserId: 1, homeScore: 70, awayScore: 50 },
    { gameweek: 30, homeUserId: 1, awayUserId: 2, homeScore: 55, awayScore: 55 },
  ];
  const entry = headToHeadRecords(fixtures, [1, 2]).get(1).get(2);
  assert.equal(entry.played, 3);
  assert.equal(entry.wins, 1);
  assert.equal(entry.draws, 1);
  assert.equal(entry.losses, 1);
  assert.equal(entry.pointsFor, 165);
  assert.equal(entry.pointsAgainst, 165);
});

// A null score is not a zero, and half a result is not a result.
test("an unplayed or half-scored fixture contributes nothing", () => {
  const fixtures = [
    { gameweek: 1, homeUserId: 1, awayUserId: 2, homeScore: null, awayScore: null },
    { gameweek: 2, homeUserId: 1, awayUserId: 2, homeScore: 60, awayScore: null },
    { gameweek: 3, homeUserId: 1, awayUserId: 2, homeScore: null, awayScore: 40 },
  ];
  assert.equal(headToHeadRecords(fixtures, [1, 2]).get(1).size, 0);
});

test("an opponent never met is omitted, not shown as a scoreless draw", () => {
  const rows = headToHeadFor(
    [{ gameweek: 1, homeUserId: 1, awayUserId: 2, homeScore: 60, awayScore: 40 }],
    members([1, 2, 3]),
    1,
  );
  assert.deepEqual(
    rows.map((r) => r.opponentId),
    [2],
  );
});

test("rows are ordered best record first, so who you own reads off the top", () => {
  const fixtures = [
    { gameweek: 1, homeUserId: 1, awayUserId: 2, homeScore: 60, awayScore: 40 }, // beat 2
    { gameweek: 2, homeUserId: 1, awayUserId: 3, homeScore: 30, awayScore: 70 }, // lost to 3
    { gameweek: 3, homeUserId: 1, awayUserId: 4, homeScore: 50, awayScore: 50 }, // drew with 4
  ];
  const rows = headToHeadFor(fixtures, members([1, 2, 3, 4]), 1);
  assert.deepEqual(
    rows.map((r) => r.opponentId),
    [2, 4, 3],
  );
});

test("formatRecord is unambiguous, and says nothing when nothing was played", () => {
  assert.equal(formatRecord({ played: 4, wins: 3, draws: 0, losses: 1 }), "W3 D0 L1");
  assert.equal(formatRecord({ played: 0, wins: 0, draws: 0, losses: 0 }), "—");
  assert.equal(formatRecord(null), "—");
});

// Average is a real opponent in an odd league and its results already count in
// the standings. Hiding it here would make the two disagree.
test("the Average opponent appears, labelled, and its results count", () => {
  const three = members([1, 2, 3]);
  const fixtures = [{ gameweek: 1, homeUserId: 1, awayUserId: 2, homeScore: 40, awayScore: 60 }];
  const scores = [
    { gameweek: 1, userId: 1, points: 40 },
    { gameweek: 1, userId: 2, points: 60 },
    { gameweek: 1, userId: 3, points: 70 },
  ];
  const merged = withAverageOpponent(fixtures, three, scores);
  const rows = headToHeadFor(merged.fixtures, merged.members, 3);

  const vsAverage = rows.find((r) => r.opponentId === AVERAGE_USER_ID);
  assert.ok(vsAverage, "manager 3 played Average and it must show");
  assert.equal(vsAverage.isAverage, true);
  assert.equal(vsAverage.isBot, false);
  assert.equal(vsAverage.wins, 1);
});

test("a manager's head-to-head wins reconcile with their overall record", () => {
  const ids = [1, 2, 3, 4];
  const fixtures = roundRobinSchedule(ids, 12).map((f, index) => ({
    ...f,
    homeScore: 50 + (index % 7),
    awayScore: 50 + ((index * 3) % 7),
  }));
  const rows = headToHeadFor(fixtures, members(ids), 1);

  const played = rows.reduce((sum, r) => sum + r.played, 0);
  const wins = rows.reduce((sum, r) => sum + r.wins, 0);
  const mine = fixtures.filter((f) => f.homeUserId === 1 || f.awayUserId === 1);
  const myWins = mine.filter((f) =>
    f.homeUserId === 1 ? f.homeScore > f.awayScore : f.awayScore > f.homeScore,
  ).length;

  assert.equal(played, mine.length);
  assert.equal(wins, myWins);
});
