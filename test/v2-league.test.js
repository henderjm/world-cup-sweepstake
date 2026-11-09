import { test } from "node:test";
import assert from "node:assert/strict";
import { firstDays, groupByDay, leagueFixtures, leagueHash, leagueResults, parseRoute, routeBase } from "../src/v2/league.js";

const SECTIONS = ["live", "fantasy", "play", "you"];

test("routes: match, league with tab and match, sections, and fallbacks", () => {
  assert.deepEqual(parseRoute("#match/42", SECTIONS), { section: "live", league: null, tab: null, matchId: "42" });
  assert.deepEqual(parseRoute("#league/PL", SECTIONS), { section: "live", league: "PL", tab: "table", matchId: null });
  assert.deepEqual(parseRoute("#league/sa/results", SECTIONS), { section: "live", league: "SA", tab: "results", matchId: null });
  assert.deepEqual(parseRoute("#league/CL/fixtures/match/7", SECTIONS), { section: "live", league: "CL", tab: "fixtures", matchId: "7" });
  assert.equal(parseRoute("#league/PL/nonsense", SECTIONS).tab, "table");
  assert.equal(parseRoute("#league/XX", SECTIONS).league, null, "an unknown competition is not a league page");
  assert.equal(parseRoute("#fantasy", SECTIONS).section, "fantasy");
  assert.equal(parseRoute("#wat", SECTIONS).section, "live");
});

test("hashes round-trip and closing a match returns to its league page", () => {
  assert.equal(leagueHash("PL"), "#league/PL");
  assert.equal(leagueHash("PL", "stats"), "#league/PL/stats");
  assert.equal(leagueHash("PL", "results", 9), "#league/PL/results/match/9");
  assert.deepEqual(parseRoute(leagueHash("PD", "results", 9), SECTIONS), { section: "live", league: "PD", tab: "results", matchId: "9" });
  assert.equal(routeBase(parseRoute("#league/PD/results/match/9", SECTIONS)), "#league/PD/results");
  assert.equal(routeBase(parseRoute("#match/9", SECTIONS)), "#live");
});

const m = (id, utcDate, status) => ({ id, utcDate, status, homeTeam: `H${id}`, awayTeam: `A${id}` });
const matches = [
  m(1, "2026-11-01T15:00:00Z", "FINISHED"),
  m(2, "2026-11-08T15:00:00Z", "FINISHED"),
  m(3, "2026-11-09T15:00:00Z", "IN_PLAY"),
  m(4, "2026-11-15T15:00:00Z", "TIMED"),
  m(5, "2026-11-14T12:30:00Z", "POSTPONED"),
  m(6, null, "TIMED"),
];

test("fixtures are everything undecided, soonest first; results are finished, newest first", () => {
  assert.deepEqual(leagueFixtures(matches).map(x => x.id), [3, 5, 4]);
  assert.deepEqual(leagueResults(matches).map(x => x.id), [2, 1]);
});

test("day groups keep order and reveal a few at a time", () => {
  const groups = groupByDay(leagueFixtures(matches));
  assert.equal(groups.length, 3);
  assert.deepEqual(firstDays(groups, 2).shown.map(g => g.matches[0].id), [3, 5]);
  assert.equal(firstDays(groups, 2).more, true);
  assert.equal(firstDays(groups, 3).more, false);
});
