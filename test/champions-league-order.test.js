import assert from "node:assert/strict";
import test from "node:test";
import { rankChampionsLeagueRows } from "../src/championsLeagueOrder.js";
import { buildModel } from "../src/data.js";
import { applyLiveResults } from "../src/liveTable.js";
import { mapApiFootballStandingsPayload } from "../src/mapApiFootball.js";

const row = (team, position, extra = {}) => ({
  team, position, played: 1, won: 1, drawn: 0, lost: 0,
  points: 3, goalDifference: 1, goalsFor: 2, awayGoals: 0, awayWins: 0, ...extra,
});
const names = result => result.rows.map(row => row.team);

test("UEFA criteria take precedence in their published order", () => {
  const criteria = ["points", "goalDifference", "goalsFor", "awayGoals", "won", "awayWins"];
  for (let i = 0; i < criteria.length; i++) {
    const a = row("Alpha", 1);
    const z = row("Zulu", 2);
    z[criteria[i]] += 1;
    for (const later of criteria.slice(i + 1)) a[later] += 100;
    const result = rankChampionsLeagueRows([a, z]);
    assert.deepEqual(names(result), ["Zulu", "Alpha"], criteria[i]);
    assert.equal(result.incomplete, false);
  }
});

test("an unknown earlier criterion preserves the published tied group, including three-way ties", () => {
  const rows = [row("Alpha", 3, { awayGoals: 4 }), row("Zulu", 1, { awayGoals: null }), row("Middle", 2, { awayGoals: 1, won: 10 })];
  const result = rankChampionsLeagueRows(rows);
  assert.deepEqual(names(result), ["Zulu", "Middle", "Alpha"]);
  assert.equal(result.incomplete, true);
  assert.deepEqual(rows.map(r => r.team), ["Alpha", "Zulu", "Middle"], "does not mutate input");
});

test("incomplete tie-break information does not prevent resolving other point groups", () => {
  const result = rankChampionsLeagueRows([
    row("Alpha", 3, { awayGoals: null }), row("Zulu", 2, { awayGoals: null }), row("Winner", 4, { points: 6 }),
  ]);
  assert.deepEqual(names(result), ["Winner", "Zulu", "Alpha"]);
  assert.equal(result.incomplete, true);
});

test("collective opponent results are used only once the eight-match league phase is complete", () => {
  const rows = Array.from({ length: 10 }, (_, i) => row(`Club ${i}`, i + 1, { played: 8 }));
  rows[8].points = 10;
  rows[9].points = 0;
  // Every club faces eight unique opponents, with five omitted disjoint pairs.
  const skipped = new Set(["0:8", "1:9", "2:3", "4:5", "6:7"]);
  const matches = [];
  for (let i = 0; i < 10; i++) for (let j = i + 1; j < 10; j++) {
    if (!skipped.has(`${i}:${j}`)) matches.push({ stage: "LEAGUE_STAGE", homeTeam: rows[i].team, awayTeam: rows[j].team });
  }
  const result = names(rankChampionsLeagueRows(rows, matches));
  assert.ok(result.indexOf("Club 1") < result.indexOf("Club 0"), "Club 1 faced the stronger opponent");
  const incomplete = names(rankChampionsLeagueRows(rows.map(r => ({ ...r, played: 7 })), matches));
  assert.ok(incomplete.indexOf("Club 0") < incomplete.indexOf("Club 1"), "early standings retain provider order after the available criteria");
});

test("settled CL tables preserve published ranks rather than alphabetizing tied clubs", () => {
  const standings = [{ type: "TOTAL", table: [
    { team: { name: "Alpha" }, position: 2, playedGames: 1, points: 3, goalDifference: 1, goalsFor: 2 },
    { team: { name: "Zulu" }, position: 1, playedGames: 1, points: 3, goalDifference: 1, goalsFor: 2 },
  ] }];
  assert.deepEqual(buildModel({ competition: "CL", standings, matches: [] }).tables[0].rows.map(r => r.team), ["Zulu", "Alpha"]);
  assert.deepEqual(buildModel({ competition: "PL", standings, matches: [] }).tables[0].rows.map(r => r.team), ["Alpha", "Zulu"]);
});

test("a live away goal increments the UEFA away-goal and away-win totals", () => {
  const rows = [row("Home", 1, { played: 0, won: 0, points: 0, goalsFor: 0, goalDifference: 0 }), row("Away", 2, { played: 0, won: 0, points: 0, goalsFor: 0, goalDifference: 0 })];
  const result = applyLiveResults({ competitionCode: "CL", rows, matches: [{
    homeTeam: "Home", awayTeam: "Away", stage: "LEAGUE_STAGE", status: "IN_PLAY", score: { home: 0, away: 2 },
  }] });
  const away = result.rows.find(r => r.team === "Away");
  assert.equal(away.awayGoals, 2);
  assert.equal(away.awayWins, 1);
  assert.equal(rows[1].awayGoals, 0);
});

test("the standings mapper distinguishes unknown away totals from zero", () => {
  const map = away => mapApiFootballStandingsPayload({ response: [{ league: { standings: [[{ team: { name: "Home" }, away }]] } }] })[0].table[0];
  assert.equal(map(undefined).awayGoals, null);
  assert.equal(map(undefined).awayWins, null);
  assert.equal(map({ goals: { for: 0 }, win: 0 }).awayGoals, 0);
  assert.equal(map({ goals: { for: 3 }, win: 1 }).awayWins, 1);
});
