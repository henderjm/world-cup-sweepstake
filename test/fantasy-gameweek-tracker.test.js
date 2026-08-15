import test from "node:test";
import assert from "node:assert/strict";

import { PLAYER_MATCH_STATES, opponentLabel, trackGameweek, trackerSummary } from "../src/fantasyGameweekTracker.js";

// Matchday 1 = gameweek 1 for these fixtures, which is what gameweekOf reads.
const fixture = (id, home, away, status, extra = {}) => ({
  id,
  utcDate: `2026-08-2${id}T14:00:00Z`,
  status,
  matchday: 1,
  homeTeam: home,
  awayTeam: away,
  score: {},
  ...extra,
});

const player = (id, name, team) => ({ id, name, team, position: "MID" });

test("each starter is placed by his club's fixture state", () => {
  const matches = [
    fixture(1, "Arsenal", "Everton", "FINISHED"),
    fixture(2, "Chelsea", "Fulham", "IN_PLAY"),
    fixture(3, "Liverpool", "Leeds United", "TIMED"),
  ];
  const roster = [player(10, "Gunner", "Arsenal"), player(11, "Blue", "Chelsea"), player(12, "Red", "Liverpool")];
  const { players, counts } = trackGameweek({ matches, roster, starterIds: [10, 11, 12], gameweek: 1 });

  assert.equal(players.find((p) => p.id === 10).state, PLAYER_MATCH_STATES.DONE);
  assert.equal(players.find((p) => p.id === 11).state, PLAYER_MATCH_STATES.IN_PLAY);
  assert.equal(players.find((p) => p.id === 12).state, PLAYER_MATCH_STATES.TO_COME);
  assert.deepEqual(counts, { total: 3, toCome: 1, inPlay: 1, done: 1, blank: 0 });
});

test("only starters are tracked; the bench is not", () => {
  const matches = [fixture(1, "Arsenal", "Everton", "FINISHED")];
  const roster = [player(10, "Starter", "Arsenal"), player(99, "Bench", "Arsenal")];
  const { players } = trackGameweek({ matches, roster, starterIds: [10], gameweek: 1 });
  assert.deepEqual(
    players.map((p) => p.id),
    [10],
  );
});

// "Done" has to mean nothing left to score, not "the first one ended".
test("a double gameweek club is not done until every one of its fixtures is", () => {
  const matches = [
    fixture(1, "Arsenal", "Everton", "FINISHED"),
    fixture(2, "Arsenal", "Chelsea", "TIMED"),
  ];
  const { players, counts } = trackGameweek({
    matches,
    roster: [player(10, "Gunner", "Arsenal")],
    starterIds: [10],
    gameweek: 1,
  });
  assert.equal(players[0].state, PLAYER_MATCH_STATES.TO_COME);
  assert.equal(players[0].fixtures.length, 2);
  assert.equal(counts.done, 0);
});

test("a live fixture wins over a finished one for the same club", () => {
  const matches = [
    fixture(1, "Arsenal", "Everton", "FINISHED"),
    fixture(2, "Arsenal", "Chelsea", "IN_PLAY"),
  ];
  const { players } = trackGameweek({
    matches,
    roster: [player(10, "Gunner", "Arsenal")],
    starterIds: [10],
    gameweek: 1,
  });
  assert.equal(players[0].state, PLAYER_MATCH_STATES.IN_PLAY);
});

// A blank club has nothing to come and nothing played. Counting him as "done"
// alongside players who actually featured would overstate how settled the
// gameweek is, so he is reported separately.
test("a blank-gameweek club is flagged blank and counted apart from done", () => {
  const matches = [fixture(1, "Chelsea", "Fulham", "FINISHED")];
  const { players, counts } = trackGameweek({
    matches,
    roster: [player(10, "Nobody", "Arsenal")],
    starterIds: [10],
    gameweek: 1,
  });
  assert.equal(players[0].blank, true);
  assert.equal(counts.blank, 1);
  assert.equal(counts.done, 0);
});

test("fixtures carry which of your starters are in them, and drop the ones you have nobody in", () => {
  const matches = [
    fixture(1, "Arsenal", "Everton", "IN_PLAY"),
    fixture(2, "Wolves", "Brentford", "IN_PLAY"), // nobody of yours
  ];
  const roster = [player(10, "Gunner", "Arsenal"), player(11, "Toffee", "Everton")];
  const { fixtures } = trackGameweek({ matches, roster, starterIds: [10, 11], gameweek: 1 });

  assert.equal(fixtures.length, 1, "a fixture with none of your players should be dropped");
  assert.equal(fixtures[0].match.id, 1);
  assert.equal(fixtures[0].yours.length, 2, "both sides of the fixture are yours");
});

test("live fixtures sort above upcoming, and upcoming above finished", () => {
  const matches = [
    fixture(1, "Arsenal", "Everton", "FINISHED"),
    fixture(2, "Chelsea", "Fulham", "TIMED"),
    fixture(3, "Liverpool", "Leeds United", "IN_PLAY"),
  ];
  const roster = [player(10, "A", "Arsenal"), player(11, "B", "Chelsea"), player(12, "C", "Liverpool")];
  const { fixtures } = trackGameweek({ matches, roster, starterIds: [10, 11, 12], gameweek: 1 });
  assert.deepEqual(
    fixtures.map((entry) => entry.match.id),
    [3, 2, 1],
  );
});

test("trackerSummary omits empty parts and says nothing for an empty XI", () => {
  assert.equal(trackerSummary({ total: 11, done: 6, inPlay: 3, toCome: 2, blank: 0 }), "6 done · 3 in play · 2 to come");
  assert.equal(trackerSummary({ total: 11, done: 11, inPlay: 0, toCome: 0, blank: 0 }), "11 done");
  assert.equal(trackerSummary({ total: 0, done: 0, inPlay: 0, toCome: 0, blank: 0 }), "");
  assert.equal(trackerSummary(null), "");
});

test("an empty or missing input does not throw", () => {
  assert.deepEqual(trackGameweek({ matches: null, roster: null, starterIds: null, gameweek: 1 }).players, []);
  assert.deepEqual(trackGameweek({}).fixtures, []);
});

test("opponentLabel names the opponent and whether it is home or away", () => {
  const home = { homeTeam: "Arsenal", awayTeam: "Coventry City" };
  const away = { homeTeam: "Everton", awayTeam: "Arsenal" };
  assert.equal(opponentLabel([home], "Arsenal"), "Coventry City (H)");
  assert.equal(opponentLabel([away], "Arsenal"), "Everton (A)");
  assert.equal(opponentLabel([home], "Arsenal", (n) => n.slice(0, 3).toUpperCase()), "COV (H)");
});

test("a double gameweek names both fixtures; a blank names none", () => {
  const fixtures = [
    { homeTeam: "Arsenal", awayTeam: "Coventry City" },
    { homeTeam: "Everton", awayTeam: "Arsenal" },
  ];
  assert.equal(opponentLabel(fixtures, "Arsenal", (n) => n.slice(0, 3).toUpperCase()), "COV (H), EVE (A)");
  assert.equal(opponentLabel([], "Arsenal"), "");
  assert.equal(opponentLabel(null, "Arsenal"), "");
});
