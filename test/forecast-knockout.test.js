import assert from "node:assert/strict";
import test from "node:test";

import { normalizeTeamName } from "../src/domain.js";
import { runForecast } from "../src/forecast.js";

function group(name, teams) {
  return { name, teams: teams.map(normalizeTeamName) };
}

function knockoutFixture({ utcDate, homeTeam, awayTeam, status = "TIMED", score = {}, winner = null }) {
  return {
    id: utcDate,
    utcDate,
    status,
    minute: status === "FINISHED" ? 120 : null,
    stage: "LAST_32",
    group: null,
    homeTeam: normalizeTeamName(homeTeam),
    awayTeam: normalizeTeamName(awayTeam),
    score: {
      home: Number.isFinite(score.home) ? score.home : null,
      away: Number.isFinite(score.away) ? score.away : null,
    },
    winner,
  };
}

test("finished knockout losers have no title odds", () => {
  const forecast = runForecast({
    groups: [
      group("Group A", ["Mexico", "Paraguay", "South Africa", "Canada"]),
      group("Group E", ["Germany", "Ivory Coast", "Ecuador", "Norway"]),
    ],
    groupMatches: [],
    knockoutMatches: [
      knockoutFixture({
        utcDate: "2026-06-28T19:00:00Z",
        homeTeam: "Mexico",
        awayTeam: "South Africa",
      }),
      knockoutFixture({
        utcDate: "2026-06-29T17:00:00Z",
        homeTeam: "Ivory Coast",
        awayTeam: "Norway",
      }),
      knockoutFixture({
        utcDate: "2026-06-29T20:30:00Z",
        homeTeam: "Germany",
        awayTeam: "Paraguay",
        status: "FINISHED",
        score: { home: 1, away: 1 },
        winner: "AWAY_TEAM",
      }),
    ],
    ownerByTeam: new Map([
      ["Germany", "Eliminated"],
      ["Paraguay", "Alive"],
    ]),
    entrants: [
      { name: "Eliminated", teams: ["Germany"] },
      { name: "Alive", teams: ["Paraguay"] },
    ],
    seed: 12345,
    iterations: 500,
  });

  assert.equal(forecast.teamTitleOdds.get("Germany"), 0);
  assert.equal(forecast.entrants.get("Eliminated").winPct, 0);
});
