import { test } from "node:test";
import assert from "node:assert/strict";
import { spotlightMatches } from "../src/spotlight.js";
import { adjacentMatchDay, matchDayStrip, matchDays } from "../src/scoreDates.js";

const match = (id, status, home, away, score, extra = {}) => ({
  id, status, homeTeam: home, awayTeam: away, competitionCode: "PL",
  utcDate: "2026-10-31T15:00:00Z", score, ...extra,
});
const follows = [{ competition: "PL", team: "Chelsea" }];

test("a followed team's live match beats a closer neutral one", () => {
  const picks = spotlightMatches([
    match(1, "IN_PLAY", "Arsenal", "Spurs", { home: 1, away: 1 }, { minute: 88 }),
    match(2, "IN_PLAY", "Chelsea", "Man United", { home: 3, away: 0 }, { minute: 60 }),
  ], follows);
  assert.deepEqual(picks.map(pick => [pick.match.id, pick.reason]), [[2, "followed"]]);
});

test("followed matches order live, then next kickoff, then latest result", () => {
  const picks = spotlightMatches([
    match(1, "FINISHED", "Chelsea", "A", { home: 1, away: 0 }),
    match(2, "TIMED", "B", "Chelsea", { home: null, away: null }),
  ], follows);
  assert.deepEqual(picks.map(pick => pick.match.id), [2, 1]);
});

test("a follow in another competition does not count", () => {
  const picks = spotlightMatches([match(1, "TIMED", "Chelsea", "A", {}, { competitionCode: "CL" })], follows);
  assert.deepEqual(picks.map(pick => pick.reason), ["next"]);
});

test("with nothing followed, the latest minute leads and the closer score breaks a tie", () => {
  const picks = spotlightMatches([
    match(1, "IN_PLAY", "A", "B", { home: 3, away: 0 }, { minute: 85 }),
    match(2, "IN_PLAY", "C", "D", { home: 1, away: 1 }, { minute: 50 }),
    match(3, "IN_PLAY", "E", "F", { home: 2, away: 2 }, { minute: 85 }),
  ]);
  assert.deepEqual(picks.map(pick => [pick.match.id, pick.reason]), [[3, "tension"]]);
});

test("nothing live and nothing followed leads with the next kickoff", () => {
  const picks = spotlightMatches([
    match(1, "TIMED", "A", "B", {}, { utcDate: "2026-10-31T17:30:00Z" }),
    match(2, "TIMED", "C", "D", {}, { utcDate: "2026-10-31T12:30:00Z" }),
  ]);
  assert.deepEqual(picks.map(pick => [pick.match.id, pick.reason]), [[2, "next"]]);
});

test("a day of results only shows no spotlight", () => {
  assert.deepEqual(spotlightMatches([match(1, "FINISHED", "A", "B", { home: 1, away: 0 })]), []);
});

test("the strip lists only matchdays around today, plus today and the selected day", () => {
  const days = matchDays([
    { utcDate: "2026-10-18T14:00:00Z" }, { utcDate: "2026-10-25T14:00:00Z" }, { utcDate: "2026-10-26T14:00:00Z" },
    { utcDate: "2026-11-01T14:00:00Z" }, { utcDate: "2026-11-04T19:00:00Z" }, { utcDate: "2026-11-04T21:00:00Z" },
  ]);
  assert.deepEqual(matchDayStrip(days, "2026-10-31", "2026-10-31"), ["2026-10-25", "2026-10-26", "2026-10-31", "2026-11-01", "2026-11-04"]);
  assert.ok(matchDayStrip(days, "2026-12-25", "2026-10-31").includes("2026-12-25"));
});

test("a swipe moves to the neighbouring matchday and stops at the season's edge", () => {
  const days = ["2026-10-25", "2026-11-01", "2026-11-04"];
  assert.equal(adjacentMatchDay(days, "2026-10-31", 1), "2026-11-01");
  assert.equal(adjacentMatchDay(days, "2026-11-01", -1), "2026-10-31");
  assert.equal(adjacentMatchDay(days, "2026-10-31", -1), "2026-10-25");
  assert.equal(adjacentMatchDay(days, "2026-11-04", 1), null);
});
