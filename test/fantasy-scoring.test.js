import assert from "node:assert/strict";
import test from "node:test";

import { scoreMatchForPlayers } from "../src/fantasyScoring.js";
import { SCORING } from "../src/fantasy.js";

// A minimal mapMatchDetail-shaped fixture: home 2-0 away, one goal with an
// assist, one own goal, one yellow, one second-yellow (YELLOW_RED), one
// substitution. Home keeps a clean sheet (away scored 0); away does not.
function fixture() {
  return {
    score: { home: 2, away: 0 },
    home: {
      lineup: [
        { id: 1, name: "Home GK", pos: "Goalkeeper", num: 1 },
        { id: 2, name: "Home DEF", pos: "Centre-Back", num: 4 },
        { id: 3, name: "Home MID", pos: "Midfield", num: 8 },
        { id: 4, name: "Home FWD", pos: "Offence", num: 9 },
      ],
      bench: [
        { id: 5, name: "Home Sub On", pos: "Midfield", num: 14 },
        { id: 6, name: "Home Unused Sub", pos: "Defence", num: 15 },
      ],
    },
    away: {
      lineup: [
        { id: 10, name: "Away GK", pos: "Goalkeeper", num: 1 },
        { id: 11, name: "Away DEF (own goal)", pos: "Defence", num: 5 },
        { id: 12, name: "Away MID", pos: "Midfield", num: 6 },
      ],
      bench: [],
    },
    goals: [
      // Home FWD scores, assisted by Home MID.
      { type: "REGULAR", scorerId: 4, assistId: 3, home: 1, away: 0 },
      // Away DEF puts one in his own net, crediting home's second goal.
      { type: "OWN", scorerId: 11, assistId: null, home: 2, away: 0 },
    ],
    cards: [
      { minute: 30, playerId: 12, card: "YELLOW" },
      { minute: 80, playerId: 10, card: "YELLOW_RED" },
    ],
    subs: [{ minute: 60, inId: 5, outId: 6 }],
  };
}

test("goals are credited by position, own goals penalize the scorer not the goal's team", () => {
  const scores = scoreMatchForPlayers(fixture());
  assert.equal(scores.get(4).breakdown.goals, SCORING.goal.FWD);
  assert.equal(scores.get(11).breakdown.ownGoals, SCORING.ownGoal);
  assert.ok(!scores.get(11).breakdown.goals);
});

test("assists are credited only for non-own-goals", () => {
  const scores = scoreMatchForPlayers(fixture());
  assert.equal(scores.get(3).breakdown.assists, SCORING.assist);
});

test("clean sheet credits the conceding-zero side by position, zero for forwards", () => {
  const scores = scoreMatchForPlayers(fixture());
  assert.equal(scores.get(1).breakdown.cleanSheet, SCORING.cleanSheet.GK); // home GK
  assert.equal(scores.get(2).breakdown.cleanSheet, SCORING.cleanSheet.DEF); // home DEF
  assert.equal(scores.get(4).breakdown.cleanSheet, 0); // home FWD gets 0
  assert.ok(!scores.get(10).breakdown.cleanSheet); // away conceded 2, no clean sheet
});

test("appearance credits starters and subs who came on, not unused bench", () => {
  const scores = scoreMatchForPlayers(fixture());
  assert.equal(scores.get(1).breakdown.appearance, SCORING.appearance); // starter
  assert.equal(scores.get(5).breakdown.appearance, SCORING.appearance); // came on
  assert.ok(!scores.has(6) || !scores.get(6).breakdown.appearance); // unused bench, no credit
});

test("a second yellow (YELLOW_RED) scores only the red penalty, not yellow plus red", () => {
  const scores = scoreMatchForPlayers(fixture());
  assert.equal(scores.get(10).breakdown.cards, SCORING.redCard);
});

test("a plain yellow scores the yellow penalty", () => {
  const scores = scoreMatchForPlayers(fixture());
  assert.equal(scores.get(12).breakdown.cards, SCORING.yellowCard);
});

test("an unused substitute is absent from or scoreless in the result", () => {
  const scores = scoreMatchForPlayers(fixture());
  const entry = scores.get(6);
  assert.ok(!entry || entry.points === 0);
});
