import assert from "node:assert/strict";
import test from "node:test";

import { applyLiveResults, withLiveTable } from "../src/liveTable.js";
import { buildModel } from "../src/data.js";

// The bug: the league table did not move while matches were being played. Not
// stale — there was no live table at all. buildLeagueTables takes the provider's
// standings verbatim (only `form` comes from match data) and providers recompute
// standings at FULL TIME, while buildTeamPerformance returns early for live
// matches. So a table watched through a 3pm round was correct and utterly still.

const row = (team, over = {}) => ({
  team,
  position: 1,
  played: 1,
  won: 1,
  drawn: 0,
  lost: 0,
  points: 3,
  goalDifference: 1,
  goalsFor: 2,
  form: [],
  zone: null,
  ...over,
});

const match = (home, away, h, a, status = "IN_PLAY") => ({
  id: `${home}-${away}`,
  homeTeam: home,
  awayTeam: away,
  status,
  utcDate: "2026-08-22T14:00:00.000Z",
  score: { home: h, away: a },
});

test("a live win moves the winner up and the loser down", () => {
  const rows = [
    row("Arsenal", { points: 3, played: 1, goalDifference: 1, goalsFor: 2 }),
    row("Chelsea", { points: 3, played: 1, goalDifference: 1, goalsFor: 2 }),
  ];
  // Chelsea 2-0 Arsenal in progress, plus each club's one finished match so the
  // provider's played=1 is consistent with what we can see.
  const matches = [
    match("Chelsea", "Arsenal", 2, 0),
    match("Chelsea", "Everton", 2, 1, "FINISHED"),
    match("Arsenal", "Fulham", 2, 1, "FINISHED"),
  ];
  const { rows: out, applied, liveTeams } = applyLiveResults({ rows, matches });

  assert.equal(applied, 1);
  assert.deepEqual([...liveTeams].sort(), ["Arsenal", "Chelsea"]);
  const chelsea = out.find((r) => r.team === "Chelsea");
  const arsenal = out.find((r) => r.team === "Arsenal");
  assert.equal(chelsea.points, 6);
  assert.equal(chelsea.played, 2);
  assert.equal(chelsea.won, 2);
  assert.equal(chelsea.goalDifference, 3);
  assert.equal(arsenal.points, 3);
  assert.equal(arsenal.lost, 1);
  assert.equal(arsenal.goalDifference, -1);
  // Re-sorted, and positions reassigned.
  assert.equal(chelsea.position, 1);
  assert.equal(arsenal.position, 2);
  assert.equal(chelsea.live, true);
});

test("a live draw gives a point each", () => {
  const rows = [row("Arsenal", { points: 0, played: 0, won: 0, goalDifference: 0, goalsFor: 0 }), row("Chelsea", { points: 0, played: 0, won: 0, goalDifference: 0, goalsFor: 0 })];
  const { rows: out } = applyLiveResults({ rows, matches: [match("Arsenal", "Chelsea", 1, 1)] });
  assert.equal(out.find((r) => r.team === "Arsenal").points, 1);
  assert.equal(out.find((r) => r.team === "Chelsea").points, 1);
  assert.equal(out.find((r) => r.team === "Arsenal").drawn, 1);
});

test("goals scored is the third tiebreak, after points and goal difference", () => {
  // Alpha won 1-0, Beta won 3-2: level on points and GD, Beta ahead on goals
  // scored. A goalless live match between them keeps all three level, so only
  // the third tiebreak can separate them.
  const rows = [
    row("Alpha", { points: 3, played: 1, goalDifference: 1, goalsFor: 1 }),
    row("Beta", { points: 3, played: 1, goalDifference: 1, goalsFor: 3 }),
  ];
  const matches = [
    match("Alpha", "Beta", 0, 0),
    match("Alpha", "Yankee", 1, 0, "FINISHED"),
    match("Beta", "Xray", 3, 2, "FINISHED"),
  ];
  const { rows: out, applied } = applyLiveResults({ rows, matches });
  assert.equal(applied, 1);
  const alpha = out.find((r) => r.team === "Alpha");
  const beta = out.find((r) => r.team === "Beta");
  assert.equal(alpha.points, 4);
  assert.equal(beta.points, 4);
  assert.equal(alpha.goalDifference, beta.goalDifference);
  assert.equal(beta.position, 1, "more goals scored breaks the tie");
  assert.equal(alpha.position, 2);
});

test("a FINISHED match is never applied", () => {
  // The provider may or may not have processed it yet, and the payload gives no
  // way to tell. Applying it would double-count for as long as they took.
  const rows = [row("Arsenal"), row("Chelsea")];
  const { rows: out, applied } = applyLiveResults({
    rows,
    matches: [match("Arsenal", "Chelsea", 3, 0, "FINISHED")],
  });
  assert.equal(applied, 0);
  assert.equal(out, rows, "a no-op must return the original array by reference");
});

test("a live match with no score yet is not applied", () => {
  const rows = [row("Arsenal"), row("Chelsea")];
  const bare = { ...match("Arsenal", "Chelsea", null, null), score: {} };
  assert.equal(applyLiveResults({ rows, matches: [bare] }).applied, 0);
});

test("the provider being ahead of us blocks the fixture, so nothing double counts", () => {
  // played=2 for Arsenal but only ONE finished match visible: the provider has
  // already counted the match we think is in progress.
  const rows = [row("Arsenal", { played: 2 }), row("Chelsea", { played: 1 })];
  const matches = [
    match("Arsenal", "Chelsea", 2, 0),
    match("Arsenal", "Fulham", 1, 0, "FINISHED"),
    match("Chelsea", "Everton", 1, 0, "FINISHED"),
  ];
  const { applied } = applyLiveResults({ rows, matches });
  assert.equal(applied, 0);
});

test("a club missing from the table skips the whole fixture, never half of it", () => {
  const rows = [row("Arsenal")];
  const { applied } = applyLiveResults({ rows, matches: [match("Arsenal", "Some Cup Side", 1, 0)] });
  assert.equal(applied, 0);
});

test("empty and missing input is a no-op", () => {
  assert.deepEqual(applyLiveResults({ rows: [], matches: [] }), { rows: [], liveTeams: new Set(), applied: 0 });
  assert.equal(applyLiveResults({}).applied, 0);
  assert.equal(applyLiveResults().applied, 0);
});

test("zones are recomputed from the new position, not carried from the old one", () => {
  const zones = [{ from: 1, to: 1, tone: "ucl", label: "Champions League" }];
  const rows = [
    row("Arsenal", { points: 3, position: 1, played: 1, goalDifference: 0, goalsFor: 1 }),
    row("Chelsea", { points: 3, position: 2, played: 1, goalDifference: 0, goalsFor: 1 }),
  ];
  const matches = [
    match("Chelsea", "Arsenal", 5, 0),
    match("Chelsea", "Everton", 1, 1, "FINISHED"),
    match("Arsenal", "Fulham", 1, 1, "FINISHED"),
  ];
  const { rows: out } = applyLiveResults({ rows, matches, zones });
  assert.equal(out[0].team, "Chelsea");
  assert.ok(out[0].zone, "the new leader must pick up the top zone");
  assert.equal(out[1].zone, null);
});

// -- the wrapper and the model ------------------------------------------------

test("withLiveTable flags only the tables it changed", () => {
  // played: 0 with nothing finished in the feed, which is gameweek 1 and the
  // simplest case where the provider is demonstrably not ahead of us.
  const fresh = () => [
    row("Arsenal", { played: 0, won: 0, points: 0, goalDifference: 0, goalsFor: 0 }),
    row("Chelsea", { played: 0, won: 0, points: 0, goalDifference: 0, goalsFor: 0 }),
  ];
  const tables = [{ name: "PL", rows: fresh() }];
  const quiet = withLiveTable({ tables, matches: [] });
  assert.equal(quiet.live, false);
  assert.equal(quiet.tables, tables);

  const busy = withLiveTable({ tables, matches: [match("Arsenal", "Chelsea", 1, 0)] });
  assert.equal(busy.live, true);
  assert.equal(busy.tables[0].live, true);
});

test("buildModel exposes the live table and says it is live", () => {
  const raw = {
    source: "API-Football",
    lastUpdated: "2026-08-22T14:00:00.000Z",
    competition: "PL",
    matches: [
      {
        id: 1,
        utcDate: "2026-08-22T14:00:00.000Z",
        status: "IN_PLAY",
        homeTeam: "Arsenal",
        awayTeam: "Chelsea",
        score: { home: 2, away: 0 },
      },
      // Last week's results, so the provider's playedGames: 1 is consistent with
      // what the feed shows and the double-count guard lets the live match through.
      { id: 2, utcDate: "2026-08-15T14:00:00.000Z", status: "FINISHED", homeTeam: "Arsenal", awayTeam: "Fulham", score: { home: 1, away: 0 } },
      { id: 3, utcDate: "2026-08-15T14:00:00.000Z", status: "FINISHED", homeTeam: "Chelsea", awayTeam: "Everton", score: { home: 2, away: 0 } },
    ],
    standings: [
      {
        type: "TOTAL",
        group: null,
        table: [
          { position: 1, team: { name: "Chelsea", shortName: "Chelsea" }, points: 3, playedGames: 1, won: 1, draw: 0, lost: 0, goalsFor: 2, goalsAgainst: 0, goalDifference: 2 },
          { position: 2, team: { name: "Arsenal", shortName: "Arsenal" }, points: 3, playedGames: 1, won: 1, draw: 0, lost: 0, goalsFor: 1, goalsAgainst: 0, goalDifference: 1 },
        ],
      },
    ],
  };
  const model = buildModel(raw);
  assert.equal(model.tablesLive, true);
  const rows = model.tables[0].rows;
  // Arsenal were second on GD; leading 2-0 live puts them top on 6 points.
  assert.equal(rows[0].team, "Arsenal");
  assert.equal(rows[0].points, 6);
  assert.equal(rows[0].live, true);
});

test("with nothing live the model's table is untouched and unflagged", () => {
  const raw = {
    source: "API-Football",
    lastUpdated: "2026-08-22T14:00:00.000Z",
    competition: "PL",
    matches: [
      { id: 1, utcDate: "2026-08-22T14:00:00.000Z", status: "FINISHED", homeTeam: "Arsenal", awayTeam: "Chelsea", score: { home: 2, away: 0 } },
    ],
    standings: [
      {
        type: "TOTAL",
        group: null,
        table: [
          { position: 1, team: { name: "Arsenal", shortName: "Arsenal" }, points: 3, playedGames: 1, won: 1, draw: 0, lost: 0, goalsFor: 2, goalsAgainst: 0, goalDifference: 2 },
        ],
      },
    ],
  };
  const model = buildModel(raw);
  assert.equal(model.tablesLive, false);
  assert.equal(model.tables[0].rows[0].points, 3);
});

test("the table renderer labels a live table and marks the moved rows", async () => {
  const { renderTable } = await import("../src/views.js");
  const html = renderTable({
    competition: { name: "PL", zones: [] },
    tables: [{ name: "PL", live: true, rows: [row("Arsenal", { live: true }), row("Chelsea")] }],
  });
  assert.match(html, /Includes matches in progress/);
  assert.match(html, /is-liverow/);

  const quiet = renderTable({
    competition: { name: "PL", zones: [] },
    tables: [{ name: "PL", rows: [row("Arsenal")] }],
  });
  assert.doesNotMatch(quiet, /Includes matches in progress/);
  assert.doesNotMatch(quiet, /is-liverow/);
});
