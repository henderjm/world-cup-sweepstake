import assert from "node:assert/strict";
import test from "node:test";

import {
  currentGameweekFromMatches,
  gameweekStatus,
  rosterGameweekPoints,
  standingsFromFixtures,
} from "../src/fantasyGameweek.js";

// -- rosterGameweekPoints -------------------------------------------------------

test("rosterGameweekPoints doubles the captain's points rather than adding a bonus", () => {
  const lineup = {
    starters: [
      { playerId: 1, isCaptain: true },
      { playerId: 2, isCaptain: false },
    ],
  };
  const points = new Map([
    [1, 5],
    [2, 7],
  ]);
  const result = rosterGameweekPoints(lineup, points);
  assert.equal(result.points, 5 * 2 + 7);
  assert.deepEqual(result.breakdown, [
    { playerId: 1, points: 10, isCaptain: true },
    { playerId: 2, points: 7, isCaptain: false },
  ]);
});

test("rosterGameweekPoints defaults a starter missing from the points map to 0", () => {
  const lineup = { starters: [{ playerId: 1, isCaptain: false }, { playerId: 99, isCaptain: true }] };
  const points = new Map([[1, 4]]); // player 99's match hasn't been scored yet
  const result = rosterGameweekPoints(lineup, points);
  assert.equal(result.points, 4); // captain (99) doubles 0, still 0
  assert.deepEqual(result.breakdown, [
    { playerId: 1, points: 4, isCaptain: false },
    { playerId: 99, points: 0, isCaptain: true },
  ]);
});

test("rosterGameweekPoints returns zero for an empty starting lineup", () => {
  const result = rosterGameweekPoints({ starters: [] }, new Map());
  assert.deepEqual(result, { points: 0, breakdown: [] });
});

// -- gameweekStatus ---------------------------------------------------------

test("gameweekStatus is scheduled when no match in that gameweek has kicked off", () => {
  const matches = [
    { matchday: 5, status: "TIMED" },
    { matchday: 5, status: "SCHEDULED" },
    { matchday: 6, status: "IN_PLAY" }, // a different gameweek must not leak in
  ];
  assert.equal(gameweekStatus(matches, 5), "scheduled");
});

test("gameweekStatus is final once every match in that gameweek is finished", () => {
  const matches = [
    { matchday: 5, status: "FINISHED" },
    { matchday: 5, status: "AWARDED" },
  ];
  assert.equal(gameweekStatus(matches, 5), "final");
});

test("gameweekStatus is live when some matches have started and others have not", () => {
  const matches = [
    { matchday: 5, status: "FINISHED" },
    { matchday: 5, status: "TIMED" },
  ];
  assert.equal(gameweekStatus(matches, 5), "live");
});

test("gameweekStatus is live for a match still in play", () => {
  const matches = [{ matchday: 5, status: "IN_PLAY" }];
  assert.equal(gameweekStatus(matches, 5), "live");
});

test("gameweekStatus is scheduled for an empty match list in that gameweek", () => {
  assert.equal(gameweekStatus([], 5), "scheduled");
  assert.equal(gameweekStatus([{ matchday: 4, status: "FINISHED" }], 5), "scheduled");
});

// -- standingsFromFixtures ---------------------------------------------------

const members = [
  { userId: 1, name: "Alice" },
  { userId: 2, name: "Bob" },
  { userId: 3, name: "Carol" },
];

test("standingsFromFixtures computes played/wins/draws/losses/pointsFor/pointsAgainst and recordPoints", () => {
  const fixtures = [
    { gameweek: 1, homeUserId: 1, awayUserId: 2, homeScore: 60, awayScore: 40 },
    { gameweek: 2, homeUserId: 2, awayUserId: 1, homeScore: 50, awayScore: 50 },
  ];
  const standings = standingsFromFixtures(fixtures, members);

  const alice = standings.find((row) => row.userId === 1);
  assert.equal(alice.played, 2);
  assert.equal(alice.wins, 1);
  assert.equal(alice.draws, 1);
  assert.equal(alice.losses, 0);
  assert.equal(alice.pointsFor, 110);
  assert.equal(alice.pointsAgainst, 90);
  assert.equal(alice.recordPoints, 4); // one win (3) plus one draw (1)

  const bob = standings.find((row) => row.userId === 2);
  assert.equal(bob.wins, 0);
  assert.equal(bob.draws, 1);
  assert.equal(bob.losses, 1);
  assert.equal(bob.recordPoints, 1);
});

test("standingsFromFixtures breaks a recordPoints tie by pointsFor", () => {
  const fixtures = [
    // Alice and Bob both go 1-0-0 for 3 recordPoints, but Bob scored more.
    { gameweek: 1, homeUserId: 1, awayUserId: 3, homeScore: 55, awayScore: 40 },
    { gameweek: 1, homeUserId: 2, awayUserId: 3, homeScore: 70, awayScore: 40 },
  ];
  const standings = standingsFromFixtures(fixtures, [
    { userId: 1, name: "Alice" },
    { userId: 2, name: "Bob" },
  ]);
  assert.deepEqual(standings.map((row) => row.userId), [2, 1]); // Bob's 70 beats Alice's 55
});

test("standingsFromFixtures excludes a fixture with a null score instead of scoring it 0-0", () => {
  const fixtures = [{ gameweek: 1, homeUserId: 1, awayUserId: 2, homeScore: null, awayScore: null }];
  const standings = standingsFromFixtures(fixtures, members);
  standings.forEach((row) => assert.equal(row.played, 0));
});

test("standingsFromFixtures excludes a fixture with only one side's score set", () => {
  const fixtures = [{ gameweek: 1, homeUserId: 1, awayUserId: 2, homeScore: 40, awayScore: undefined }];
  const standings = standingsFromFixtures(fixtures, members);
  standings.forEach((row) => assert.equal(row.played, 0));
});

test("standingsFromFixtures still lists a member with a bye week, played reflecting only real fixtures", () => {
  // Carol has no fixture at all this round (odd league size bye); she must
  // still appear in the table rather than being dropped.
  const fixtures = [{ gameweek: 1, homeUserId: 1, awayUserId: 2, homeScore: 60, awayScore: 30 }];
  const standings = standingsFromFixtures(fixtures, members);
  const carol = standings.find((row) => row.userId === 3);
  assert.ok(carol);
  assert.equal(carol.played, 0);
  assert.equal(carol.recordPoints, 0);
});

// -- gameweekStatus with a postponed/cancelled fixture -----------------------

test("gameweekStatus treats a postponed match as settled, not perpetually live", () => {
  // A postponed fixture never becomes FINISHED/AWARDED, so a naive
  // isFinished-only check would keep this gameweek "live" forever even
  // though nothing further is going to happen in it.
  const matches = [
    { matchday: 5, status: "FINISHED" },
    { matchday: 5, status: "POSTPONED" },
  ];
  assert.equal(gameweekStatus(matches, 5), "final");
});

test("gameweekStatus treats a cancelled match the same way", () => {
  const matches = [
    { matchday: 5, status: "FINISHED" },
    { matchday: 5, status: "CANCELLED" },
  ];
  assert.equal(gameweekStatus(matches, 5), "final");
});

// -- currentGameweekFromMatches -----------------------------------------------

test("currentGameweekFromMatches returns the smallest matchday with an unsettled match", () => {
  const matches = [
    { matchday: 3, status: "FINISHED" },
    { matchday: 4, status: "IN_PLAY" },
    { matchday: 5, status: "TIMED" },
  ];
  assert.equal(currentGameweekFromMatches(matches), 4);
});

test("currentGameweekFromMatches is not stuck forever by a postponed match in an earlier gameweek", () => {
  // Gameweek 4 has one postponed fixture (never becomes FINISHED/AWARDED)
  // alongside a finished one; gameweek 5 is still fully upcoming. The
  // postponed match must not freeze "current" at 4 forever.
  const matches = [
    { matchday: 4, status: "FINISHED" },
    { matchday: 4, status: "POSTPONED" },
    { matchday: 5, status: "TIMED" },
  ];
  assert.equal(currentGameweekFromMatches(matches), 5);
});

test("currentGameweekFromMatches rolls one gameweek past the season once everything is settled", () => {
  // Every match done (including a cancellation): the final real gameweek
  // must count as fully in the past, or standings (gameweek < current)
  // would exclude it forever.
  const matches = [
    { matchday: 37, status: "FINISHED" },
    { matchday: 38, status: "FINISHED" },
    { matchday: 38, status: "CANCELLED" },
  ];
  assert.equal(currentGameweekFromMatches(matches), 39);
});

test("currentGameweekFromMatches defaults to 1 for an empty or matchday-less match list", () => {
  assert.equal(currentGameweekFromMatches([]), 1);
  assert.equal(currentGameweekFromMatches([{ status: "FINISHED" }]), 1);
});
