import { test } from "node:test";
import assert from "node:assert/strict";
import { clubFixtures } from "../src/v2/matchCentre.js";

const m = (id, status, utcDate, homeTeam, awayTeam, competitionCode = "PL") => ({ id, status, utcDate, homeTeam, awayTeam, competitionCode });
const matches = [
  m(1, "FINISHED", "2026-11-01T15:00:00Z", "Arsenal", "Chelsea"),
  m(2, "FINISHED", "2026-11-08T15:00:00Z", "Fulham", "Arsenal"),
  m(3, "TIMED", "2026-11-29T15:00:00Z", "Arsenal", "Everton"),
  m(4, "IN_PLAY", "2026-11-21T15:00:00Z", "Brentford", "Arsenal"),
  m(5, "TIMED", "2026-11-25T20:00:00Z", "Arsenal", "Inter", "CL"),
  m(6, "CANCELLED", "2026-12-06T15:00:00Z", "Arsenal", "Wolves"),
  m(7, "TIMED", "2026-11-29T15:00:00Z", "Leeds", "Burnley"),
];

test("one club in one competition: live first, then soonest; results newest first", () => {
  const lists = clubFixtures(matches, "PL", "Arsenal");
  assert.deepEqual(lists.upcoming.flatMap(group => group.matches.map(match => match.id)), [4, 3]);
  assert.deepEqual(lists.results.flatMap(group => group.matches.map(match => match.id)), [2, 1]);
  assert.deepEqual(lists.counts, { upcoming: 2, results: 2 });
});

test("other competitions, other clubs and cancelled matches are left out", () => {
  const ids = Object.values(clubFixtures(matches, "PL", "Arsenal")).flat().flatMap(group => group.matches?.map(match => match.id) ?? []);
  assert.equal(ids.includes(5), false);
  assert.equal(ids.includes(6), false);
  assert.equal(ids.includes(7), false);
});

test("matches are grouped by day", () => {
  const two = clubFixtures([m(1, "TIMED", "2026-11-29T12:00:00Z", "A", "B"), m(2, "TIMED", "2026-11-29T15:00:00Z", "C", "A")], "PL", "A");
  assert.equal(two.upcoming.length, 1);
  assert.equal(two.upcoming[0].matches.length, 2);
});
