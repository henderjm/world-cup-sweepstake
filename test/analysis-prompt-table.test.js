import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAnalysisPrompt } from "../src/analysisPrompt.js";

// The provider's standings lag the whistle. The full-time read must quote the
// table WITH the result in it, as the app's own table does (QA, 1 Nov 2026:
// "Chelsea climb to 13 points" while the table showed 16).
const row = (name, position, points, played) => ({
  position, team: { name, shortName: name }, playedGames: played, won: 0, draw: 0, lost: 0,
  points, goalsFor: 0, goalsAgainst: 0, goalDifference: 0,
});
const live = {
  competition: "PL",
  standings: [{ type: "TOTAL", table: [row("Liverpool", 1, 16, 8), row("Chelsea", 2, 13, 8), row("Manchester United", 3, 7, 8)] }],
  matches: [{
    id: 1, status: "FINISHED", utcDate: "2026-10-31T12:30:00Z", homeTeam: "Chelsea", awayTeam: "Manchester United",
    score: { home: 2, away: 0 },
  }],
};
const detail = { home: { name: "Chelsea" }, away: { name: "Manchester United" }, status: "FINISHED", score: { home: 2, away: 0 } };

test("a full-time read quotes the table after the result, not before", () => {
  // Eight earlier results each plus this one: the feed shows nine finished
  // matches against eight played, so this result is the missing one.
  const history = [];
  for (let i = 0; i < 8; i += 1) {
    history.push({ id: 100 + i, status: "FINISHED", utcDate: `2026-09-0${(i % 9) + 1}T12:00:00Z`, homeTeam: "Chelsea", awayTeam: `X${i}`, score: { home: 1, away: 1 } });
    history.push({ id: 200 + i, status: "FINISHED", utcDate: `2026-09-0${(i % 9) + 1}T12:00:00Z`, homeTeam: "Manchester United", awayTeam: `Y${i}`, score: { home: 1, away: 1 } });
  }
  const payload = JSON.parse(buildAnalysisPrompt(detail, { ...live, matches: [...history, ...live.matches] }));
  assert.equal(payload.match.home.points, 16);
  assert.equal(payload.match.home.played, 9);
  assert.equal(payload.match.away.points, 7);
});

test("a result the provider has already counted is not counted twice", () => {
  const counted = { ...live, standings: [{ type: "TOTAL", table: [row("Liverpool", 1, 16, 9), row("Chelsea", 2, 16, 9), row("Manchester United", 3, 7, 9)] }] };
  const history = [];
  for (let i = 0; i < 8; i += 1) {
    history.push({ id: 100 + i, status: "FINISHED", utcDate: "2026-09-01T12:00:00Z", homeTeam: "Chelsea", awayTeam: `X${i}`, score: { home: 1, away: 1 } });
    history.push({ id: 200 + i, status: "FINISHED", utcDate: "2026-09-01T12:00:00Z", homeTeam: "Manchester United", awayTeam: `Y${i}`, score: { home: 1, away: 1 } });
  }
  const payload = JSON.parse(buildAnalysisPrompt(detail, { ...counted, matches: [...history, ...live.matches] }));
  assert.equal(payload.match.home.points, 16);
  assert.equal(payload.match.home.played, 9);
});
