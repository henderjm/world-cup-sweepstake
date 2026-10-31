import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultMatchDay, freshness, groupByCompetition, latestKeyMoment, matchPhase, moments,
  playerOfMatch, ratedPitch, scorerLines, statRows,
} from "../src/v2/matchCentre.js";

const detail = {
  home: { name: "Chelsea", lineup: [
    { id: 1, name: "Robert Sánchez", grid: "1:1" },
    { id: 2, name: "Cole Palmer", grid: "2:1" },
  ] },
  away: { name: "Manchester United", lineup: [{ id: 3, name: "André Onana", grid: "1:1" }, { id: 4, name: "Diogo Dalot", grid: "2:1" }] },
  goals: [
    { minute: 23, team: "Chelsea", scorerId: 2, scorer: "Cole Palmer", home: 1, away: 0 },
    { minute: 41, team: "Manchester United", scorer: "Matheus Cunha", assist: "Bruno Fernandes", home: 1, away: 1 },
    { minute: 64, team: "Chelsea", scorerId: 2, scorer: "Cole Palmer", home: 2, away: 1 },
  ],
  cards: [{ minute: 58, team: "Manchester United", player: "Diogo Dalot", card: "YELLOW_RED" }],
  subs: [{ minute: 70, team: "Chelsea", in: "Pedro Neto", out: "Noni Madueke" }],
  playerStats: [
    { playerId: 1, team: "Chelsea", rating: 6.9, shots: null, shotsOnTarget: null },
    { playerId: 2, player: "Cole Palmer", team: "Chelsea", rating: 8.2, shots: 5, shotsOnTarget: 3, keyPasses: 4 },
    { playerId: 3, team: "Manchester United", rating: null, shots: null, shotsOnTarget: null },
    { playerId: 4, team: "Manchester United", rating: 5.9, shots: 2, shotsOnTarget: 0 },
  ],
};

test("phase follows status", () => {
  assert.equal(matchPhase({ status: "IN_PLAY" }), "live");
  assert.equal(matchPhase({ status: "FINISHED" }), "post");
  assert.equal(matchPhase({ status: "TIMED" }), "pre");
  assert.equal(matchPhase({ status: "POSTPONED" }), "off");
});

test("default day is today, else the next matchday, else the last", () => {
  assert.equal(defaultMatchDay(["2026-10-31"], "2026-10-31"), "2026-10-31");
  assert.equal(defaultMatchDay(["2026-10-25", "2026-11-04"], "2026-10-31"), "2026-11-04");
  assert.equal(defaultMatchDay(["2026-10-25"], "2026-10-31"), "2026-10-25");
});

test("list groups follow competition order and kickoff", () => {
  const groups = groupByCompetition([
    { competitionCode: "CL", homeTeam: "A", utcDate: "2026-10-31T20:00:00Z" },
    { competitionCode: "PL", homeTeam: "C", utcDate: "2026-10-31T15:00:00Z" },
    { competitionCode: "PL", homeTeam: "B", utcDate: "2026-10-31T12:30:00Z" },
  ], ["PL", "CL"]);
  assert.deepEqual(groups.map(group => [group.code, group.matches.map(match => match.homeTeam)]), [["PL", ["B", "C"]], ["CL", ["A"]]]);
});

test("scorer lines group a brace under one name", () => {
  assert.deepEqual(scorerLines(detail, "Chelsea"), { home: ["Palmer 23', 64'"], away: ["Cunha 41'"] });
});

test("moments run newest first and the spotlight line is the last goal or red", () => {
  assert.deepEqual(moments(detail, "Chelsea").map(item => item.kind), ["sub", "goal", "red", "goal", "goal"]);
  assert.equal(latestKeyMoment(detail, "Chelsea").minute, 64);
});

test("stat bars omit what the provider has not returned and never draw a zero for it", () => {
  const rows = statRows(detail, "Chelsea", "Manchester United");
  assert.deepEqual(rows.map(row => [row.label, row.text]), [
    ["Shots", ["5", "2"]], ["On target", ["3", "0"]], ["Cards", ["0", "1"]],
  ]);
  assert.equal(statRows({}, "A", "B").length, 0);
});

test("team statistics from the provider win over summed player figures", () => {
  const rows = statRows({ ...detail, teamStats: { home: { xg: 2.06, shots: 17, possession: 57 }, away: { xg: 1.13, shots: 11, possession: 43 } } }, "Chelsea", "Manchester United");
  assert.deepEqual(rows.slice(0, 3).map(row => row.text), [["2.06", "1.13"], ["17", "11"], ["3", "0"]]);
});

test("the pitch carries ratings, leaves unrated players blank and marks the best", () => {
  const pitch = ratedPitch(detail, "home");
  assert.deepEqual(pitch.flat().map(player => [player.name, player.rating, player.top]), [["Sánchez", 6.9, false], ["Palmer", 8.2, true]]);
  assert.equal(ratedPitch(detail, "away").flat()[0].rating, null);
});

test("player of the match is the highest rating with his own numbers", () => {
  assert.deepEqual(playerOfMatch(detail), { name: "Cole Palmer", team: "Chelsea", rating: 8.2, line: "2 goals · 4 key passes" });
  assert.equal(playerOfMatch({ playerStats: [{ rating: null }] }), null);
});

test("freshness is the data's age and live data over two minutes old is delayed", () => {
  const now = Date.parse("2026-10-31T15:00:00Z");
  assert.deepEqual(freshness({ lastUpdated: "2026-10-31T14:59:52Z", live: true }, now), { text: "Updated 8s ago", delayed: false });
  assert.deepEqual(freshness({ lastUpdated: "2026-10-31T14:56:00Z", live: true }, now), { text: "Delayed, 4m ago", delayed: true });
  assert.deepEqual(freshness({ lastUpdated: "2026-10-31T14:56:00Z" }, now), { text: "Updated 4m ago", delayed: false });
});
