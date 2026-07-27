import test from "node:test";
import assert from "node:assert/strict";

import {
  RECENT_FORM_WINDOW,
  attachRankMovement,
  buildPowerRankings,
  gameweekAwards,
  matchupResults,
  median,
} from "../src/fantasyRecap.js";

const MANAGERS = [
  { userId: 1, name: "Ada" },
  { userId: 2, name: "Bo" },
  { userId: 3, name: "Cy" },
  { userId: 4, name: "Di" },
];

// Two gameweeks, four managers, every fixture decided.
const FIXTURES = [
  { gameweek: 1, homeUserId: 1, awayUserId: 2, homeScore: 70, awayScore: 40 },
  { gameweek: 1, homeUserId: 3, awayUserId: 4, homeScore: 55, awayScore: 50 },
  { gameweek: 2, homeUserId: 1, awayUserId: 3, homeScore: 80, awayScore: 45 },
  { gameweek: 2, homeUserId: 2, awayUserId: 4, homeScore: 42, awayScore: 60 },
];

const SCORES = [
  { userId: 1, gameweek: 1, points: 70 },
  { userId: 2, gameweek: 1, points: 40 },
  { userId: 3, gameweek: 1, points: 55 },
  { userId: 4, gameweek: 1, points: 50 },
  { userId: 1, gameweek: 2, points: 80 },
  { userId: 2, gameweek: 2, points: 42 },
  { userId: 3, gameweek: 2, points: 45 },
  { userId: 4, gameweek: 2, points: 60 },
];

test("median handles odd, even and empty inputs", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
  assert.equal(median([1, null, NaN, 3]), 2);
});

test("buildPowerRankings ranks the best manager first and numbers every row", () => {
  const rankings = buildPowerRankings({ managers: MANAGERS, fixtures: FIXTURES, scores: SCORES, throughGameweek: 2 });
  assert.equal(rankings.length, 4);
  assert.deepEqual(
    rankings.map((row) => row.rank),
    [1, 2, 3, 4],
  );
  assert.equal(rankings[0].userId, 1);
  assert.equal(rankings[0].wins, 2);
  assert.equal(rankings[0].seasonAvg, 75);
});

test("buildPowerRankings only counts gameweeks up to throughGameweek", () => {
  const throughOne = buildPowerRankings({
    managers: MANAGERS,
    fixtures: FIXTURES,
    scores: SCORES,
    throughGameweek: 1,
  });
  for (const row of throughOne) {
    assert.equal(row.played, 1, `${row.name} should have played exactly one fixture`);
  }
  assert.equal(throughOne.find((row) => row.userId === 1).seasonAvg, 70);
});

test("buildPowerRankings keeps a manager who has never scored, with zeroes rather than dropping them", () => {
  const rankings = buildPowerRankings({
    managers: [...MANAGERS, { userId: 9, name: "Newcomer" }],
    fixtures: FIXTURES,
    scores: SCORES,
    throughGameweek: 2,
  });
  const newcomer = rankings.find((row) => row.userId === 9);
  assert.ok(newcomer, "a manager with no scored gameweek must still be ranked");
  assert.equal(newcomer.played, 0);
  assert.equal(newcomer.seasonAvg, 0);
  assert.equal(newcomer.winPct, 0);
  assert.equal(newcomer.lastGameweekPoints, null);
});

test("buildPowerRankings weights recent form, so a late surge outranks an equal season average", () => {
  const managers = [
    { userId: 1, name: "Fading" },
    { userId: 2, name: "Surging" },
  ];
  // Identical season totals, mirror-image trajectories, and more gameweeks
  // than RECENT_FORM_WINDOW so the window genuinely bites. No fixtures at all,
  // so the record term is zero for both and only form can separate them.
  const trajectory = [90, 75, 60, 45, 30];
  const scores = [
    ...trajectory.map((points, index) => ({ userId: 1, gameweek: index + 1, points })),
    ...[...trajectory].reverse().map((points, index) => ({ userId: 2, gameweek: index + 1, points })),
  ];
  const rankings = buildPowerRankings({ managers, fixtures: [], scores, throughGameweek: trajectory.length });
  assert.equal(rankings[0].name, "Surging");
  assert.equal(rankings[0].seasonAvg, rankings[1].seasonAvg);
});

test("buildPowerRankings recent average uses only the last RECENT_FORM_WINDOW gameweeks", () => {
  const scores = Array.from({ length: 6 }, (_, index) => ({ userId: 1, gameweek: index + 1, points: 10 }));
  scores[5].points = 100; // gameweek 6
  const [row] = buildPowerRankings({
    managers: [{ userId: 1, name: "Solo" }],
    fixtures: [],
    scores,
    throughGameweek: 6,
  });
  const expected = (10 * (RECENT_FORM_WINDOW - 1) + 100) / RECENT_FORM_WINDOW;
  assert.equal(row.recentAvg, Math.round(expected * 10) / 10);
});

test("buildPowerRankings skips a fixture whose scores are not both in", () => {
  const rankings = buildPowerRankings({
    managers: MANAGERS,
    fixtures: [...FIXTURES, { gameweek: 3, homeUserId: 1, awayUserId: 4, homeScore: 55, awayScore: null }],
    scores: SCORES,
    throughGameweek: 3,
  });
  assert.equal(rankings.find((row) => row.userId === 1).played, 2);
});

test("attachRankMovement reports climbs as positive and a new entry as null", () => {
  const previous = [
    { userId: 1, rank: 1 },
    { userId: 2, rank: 2 },
  ];
  const current = [
    { userId: 2, rank: 1 },
    { userId: 1, rank: 2 },
    { userId: 3, rank: 3 },
  ];
  const moved = attachRankMovement(current, previous);
  assert.equal(moved[0].movement, 1); // 2 -> 1
  assert.equal(moved[1].movement, -1); // 1 -> 2
  assert.equal(moved[2].movement, null);
  assert.equal(moved[2].previousRank, null);
});

test("matchupResults reports winners, draws and margins, and drops undecided fixtures", () => {
  const results = matchupResults({
    fixtures: [
      { gameweek: 2, homeUserId: 1, awayUserId: 3, homeScore: 80, awayScore: 45 },
      { gameweek: 2, homeUserId: 2, awayUserId: 4, homeScore: 50, awayScore: 50 },
      { gameweek: 2, homeUserId: 5, awayUserId: 6, homeScore: null, awayScore: 20 },
      { gameweek: 1, homeUserId: 1, awayUserId: 2, homeScore: 70, awayScore: 40 },
    ],
    gameweek: 2,
  });
  assert.equal(results.length, 2);
  assert.equal(results[0].winnerUserId, 1);
  assert.equal(results[0].margin, 35);
  assert.equal(results[1].winnerUserId, null);
  assert.equal(results[1].margin, 0);
});

// -- Awards --------------------------------------------------------------------

const PLAYERS = new Map([
  [10, { name: "Raya", team: "Arsenal" }],
  [11, { name: "Saka", team: "Arsenal" }],
  [12, { name: "Haaland", team: "Man City" }],
  [13, { name: "Wissa", team: "Brentford" }],
  [14, { name: "Isak", team: "Newcastle" }],
]);

test("gameweekAwards hands the bench king to the biggest wasted bench", () => {
  const awards = gameweekAwards({
    managers: MANAGERS,
    lineups: [
      { userId: 1, starters: [{ playerId: 10, isCaptain: true }], bench: [12, 13] },
      { userId: 2, starters: [{ playerId: 11, isCaptain: true }], bench: [14] },
    ],
    playerPoints: new Map([
      [10, 6],
      [11, 5],
      [12, 18],
      [13, 4],
      [14, 3],
    ]),
    players: PLAYERS,
    results: [],
    scores: [],
  });
  assert.equal(awards.benchKing.userId, 1);
  assert.equal(awards.benchKing.points, 22);
  assert.match(awards.benchKing.detail, /Haaland led the bench on 18/);
});

test("gameweekAwards returns no bench king when every bench blanked", () => {
  const awards = gameweekAwards({
    managers: MANAGERS,
    lineups: [{ userId: 1, starters: [{ playerId: 10, isCaptain: true }], bench: [12] }],
    playerPoints: new Map([
      [10, 6],
      [12, 0],
    ]),
    players: PLAYERS,
    results: [],
    scores: [],
  });
  assert.equal(awards.benchKing, null);
});

test("gameweekAwards costs the worst captain against the best player in their own XI", () => {
  const awards = gameweekAwards({
    managers: MANAGERS,
    lineups: [
      {
        userId: 2,
        starters: [
          { playerId: 10, isCaptain: true },
          { playerId: 12, isCaptain: false },
        ],
        bench: [],
      },
    ],
    playerPoints: new Map([
      [10, 2],
      [12, 15],
    ]),
    players: PLAYERS,
    results: [],
    scores: [],
  });
  assert.equal(awards.worstCaptain.userId, 2);
  assert.equal(awards.worstCaptain.points, 13);
  assert.match(awards.worstCaptain.detail, /captained Raya on 2 with Haaland on 15/);
});

test("gameweekAwards gives no worst-captain award when everyone captained their top scorer", () => {
  const awards = gameweekAwards({
    managers: MANAGERS,
    lineups: [
      {
        userId: 2,
        starters: [
          { playerId: 12, isCaptain: true },
          { playerId: 10, isCaptain: false },
        ],
        bench: [],
      },
    ],
    playerPoints: new Map([
      [10, 2],
      [12, 15],
    ]),
    players: PLAYERS,
    results: [],
    scores: [],
  });
  assert.equal(awards.worstCaptain, null);
});

test("gameweekAwards finds the win furthest below the league median", () => {
  const scores = [
    { userId: 1, points: 90 },
    { userId: 2, points: 70 },
    { userId: 3, points: 30 },
    { userId: 4, points: 20 },
  ];
  const awards = gameweekAwards({
    managers: MANAGERS,
    lineups: [],
    playerPoints: new Map(),
    players: PLAYERS,
    // Median is 50. Manager 3 wins on 30, twenty below it.
    results: [
      { homeUserId: 1, awayUserId: 2, homeScore: 90, awayScore: 70, winnerUserId: 1, margin: 20 },
      { homeUserId: 3, awayUserId: 4, homeScore: 30, awayScore: 20, winnerUserId: 3, margin: 10 },
    ],
    scores,
  });
  assert.equal(awards.luckiestWin.userId, 3);
  assert.equal(awards.luckiestWin.points, 20);
  assert.match(awards.luckiestWin.detail, /below the league median of 50/);
});

test("gameweekAwards gives no luckiest win when every winner beat the median", () => {
  const awards = gameweekAwards({
    managers: MANAGERS,
    lineups: [],
    playerPoints: new Map(),
    players: PLAYERS,
    results: [{ homeUserId: 1, awayUserId: 2, homeScore: 90, awayScore: 70, winnerUserId: 1, margin: 20 }],
    scores: [
      { userId: 1, points: 90 },
      { userId: 2, points: 70 },
    ],
  });
  assert.equal(awards.luckiestWin, null);
});

test("gameweekAwards survives an empty league without throwing or inventing winners", () => {
  const awards = gameweekAwards({});
  assert.deepEqual(awards, { benchKing: null, worstCaptain: null, luckiestWin: null });
});
