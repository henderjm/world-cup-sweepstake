import assert from "node:assert/strict";
import test from "node:test";
import { knockoutRounds, selectedKnockoutRound, summarizeTie } from "../src/knockout.js";
import { readScoreRoute, scoreRouteHash } from "../src/scoreDates.js";
import { renderKnockout } from "../src/views.js";

const leg = (id, home, away, score, extra = {}) => ({ id, homeTeam: home, awayTeam: away, score,
  status: "FINISHED", stage: "PLAYOFF_ROUND", utcDate: id === 1 ? "2027-02-10T20:00Z" : "2027-02-17T20:00Z", ...extra });
const pair = () => [leg(1, "A", "B", { home: 2, away: 0 }), leg(2, "B", "A", { home: 1, away: 1 })];
const summarize = matches => summarizeTie(matches, "PLAYOFF_ROUND", "CL");

test("two legs aggregate by team despite reversed home/away orientation and input ordering", () => {
  const result = summarize(pair().reverse());
  assert.deepEqual(result.aggregate, [3, 1]);
  assert.equal(result.winner, "A");
  assert.deepEqual(result.legs.map(match => match.id), [1, 2]);
});

test("the winner of the second match does not override the aggregate winner", () => {
  const matches = pair();
  matches[1].score = { home: 1, away: 0 };
  matches[1].winner = "HOME_TEAM";
  assert.equal(summarize(matches).winner, "A");
});

test("away goals do not decide a tied aggregate", () => {
  const matches = [leg(1, "A", "B", { home: 2, away: 1 }), leg(2, "B", "A", { home: 1, away: 0 })];
  const result = summarize(matches);
  assert.deepEqual(result.aggregate, [2, 2]);
  assert.equal(result.winner, null);
  assert.equal(result.state, "unconfirmed");
});

test("shoot-out goals stay separate and are oriented to the same teams as the aggregate", () => {
  const matches = [leg(1, "A", "B", { home: 1, away: 1 }), leg(2, "B", "A", { home: 1, away: 1 }, { penalties: { home: 4, away: 1 } })];
  const result = summarize(matches);
  assert.deepEqual(result.aggregate, [2, 2]);
  assert.deepEqual(result.penalties, [1, 4]);
  assert.equal(result.winner, "B");
});

test("live scores and penalties cannot prematurely confirm advancement", () => {
  const matches = [leg(1, "A", "B", { home: 1, away: 1 }), leg(2, "B", "A", { home: 1, away: 1 }, { status: "PENALTY_SHOOTOUT", penalties: { home: 4, away: 1 } })];
  assert.equal(summarize(matches).state, "live");
  assert.equal(summarize(matches).winner, null);
});

test("one completed leg has a provisional aggregate only when the return fixture is known", () => {
  const matches = pair();
  matches[1].status = "TIMED";
  matches[1].score = { home: null, away: null };
  assert.deepEqual(summarize(matches).aggregate, [2, 0]);
  assert.equal(summarize(matches).state, "first-leg");
  assert.equal(summarize(matches.slice(0, 1)).aggregate, null);
  assert.equal(summarize(matches.slice(0, 1)).winner, null);
});

test("missing scores, duplicate fixtures, replays and unclear leg ordering do not invent aggregates", () => {
  const matches = pair();
  for (const candidate of [[matches[0], { ...matches[1], score: {} }], [matches[0], matches[0]], [...matches, { ...matches[0], id: 3 }],
    [matches[0], { ...matches[1], utcDate: matches[0].utcDate }], [matches[0], { ...matches[1], status: "AWARDED" }]]) {
    assert.equal(summarize(candidate).aggregate, null);
    assert.equal(summarize(candidate).winner, null);
  }
});

test("a final is one match, while an unknown competition or round cannot inherit CL rules", () => {
  const final = leg(1, "A", "B", { home: 2, away: 1 }, { stage: "FINAL" });
  assert.equal(summarizeTie([final], "FINAL", "CL").winner, "A");
  assert.equal(summarizeTie(pair(), "PLAYOFF_ROUND", "other").winner, null);
  assert.equal(summarizeTie(pair(), "UNRECOGNIZED_ROUND", "CL").aggregate, null);
});

test("scheduled legs remain undecided, and administrative or postponed outcomes are not ordinary results", () => {
  const scheduled = pair().map(match => ({ ...match, status: "TIMED", score: {} }));
  assert.equal(summarize(scheduled).state, "scheduled");
  assert.equal(summarize(scheduled).winner, null);
  for (const status of ["AWARDED", "POSTPONED", "CANCELLED"]) {
    const result = summarize(scheduled.map(match => ({ ...match, status })));
    assert.equal(result.state, "unconfirmed");
    assert.equal(result.aggregate, null);
  }
  assert.equal(summarize([{ ...pair()[0], status: "TIMED" }, pair()[1]]).aggregate, null);
});

test("conflicting penalty and aggregate totals require confirmation", () => {
  const matches = pair();
  matches[1].penalties = { home: 4, away: 1 };
  assert.equal(summarize(matches).winner, null);
});

test("qualifying history is separate and defaults to the latest completed round", () => {
  const rounds = knockoutRounds({ competition: { code: "CL" }, matches: [
    ...pair().map(match => ({ ...match, stage: "FIRST_QUALIFYING_ROUND" })),
    ...pair().map(match => ({ ...match, id: match.id + 2, stage: "PLAYOFFS" })),
    leg(5, "C", "D", {}, { stage: "LEAGUE_STAGE" }),
  ] });
  assert.equal(rounds.length, 2);
  assert.equal(selectedKnockoutRound(rounds).selected, undefined);
  assert.equal(selectedKnockoutRound(rounds, { phase: "qualifying" }).selected.stage, "PLAYOFFS");
  assert.equal(selectedKnockoutRound(rounds, { phase: "qualifying", round: "FIRST_QUALIFYING_ROUND" }).selected.stage, "FIRST_QUALIFYING_ROUND");
});

test("phase and round survive route reload and published main fixtures appear without future placeholders", () => {
  const route = readScoreRoute(scoreRouteHash({ tab: "knockout", competition: "CL", phase: "qualifying", round: "PLAYOFFS" }));
  assert.equal(route.phase, "qualifying");
  assert.equal(route.round, "PLAYOFFS");
  const model = { competition: { code: "CL" }, matches: pair().map(match => ({ ...match, stage: "PLAYOFFS" })) };
  const main = renderKnockout(model);
  assert.match(main, /No knockout fixtures published yet/);
  assert.doesNotMatch(main, /data-match-id/);
  assert.equal((renderKnockout(model, route).match(/data-match-id=/g) ?? []).length, 2);
});
