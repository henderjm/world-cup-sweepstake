import assert from "node:assert/strict";
import test from "node:test";
import { buildModel } from "../src/data.js";
import { formatStage, statusLabel } from "../src/format.js";
import { mapApiFootballMatches, mapApiFootballMatchDetail } from "../src/mapApiFootball.js";
import { renderHero, renderKnockout, renderLive } from "../src/views.js";

const fixture = (id, stage, homeTeam, awayTeam, status = "FINISHED", score = { home: 1, away: 0 }) => ({
  id, stage, homeTeam, awayTeam, status, score,
  utcDate: `2026-09-${String(id).padStart(2, "0")}T19:00:00Z`,
  matchday: stage === "LEAGUE_STAGE" ? 1 : null,
});
const standing = (team, points, won) => ({
  team: { name: team }, points, playedGames: 1, won, draw: 0, lost: 1 - won,
  goalsFor: won, goalsAgainst: 1 - won, goalDifference: won ? 1 : -1,
});

test("qualifying matches cannot double-count a completed league-phase result or contaminate form", () => {
  const matches = [
    fixture(1, "PLAYOFFS", "AEK Athens FC", "Qualifying opponent"),
    fixture(2, "PLAYOFFS", "League opponent", "Another qualifier"),
    fixture(3, "LEAGUE_STAGE", "AEK Athens FC", "League opponent"),
  ];
  const model = buildModel({
    competition: "CL", matches,
    standings: [{ type: "TOTAL", table: [standing("AEK Athens FC", 3, 1), standing("League opponent", 0, 0)] }],
  });
  assert.equal(model.tablesLive, false);
  const aek = model.tables[0].rows.find(row => row.team === "AEK Athens FC");
  assert.equal(aek.points, 3);
  assert.equal(aek.played, 1);
  assert.equal(aek.form.length, 1);
  assert.equal(model.matches.length, 3, "qualifiers remain accessible in fixtures and knockout views");
});

test("live qualifying and knockout games cannot change league-phase standings", () => {
  for (const stage of ["FIRST_QUALIFYING_ROUND", "PLAYOFFS", "PLAYOFF_ROUND", "ROUND_OF_16", "FINAL"]) {
    const model = buildModel({
      competition: "CL", matches: [fixture(1, stage, "Home", "Away", "IN_PLAY")],
      standings: [{ type: "TOTAL", table: ["Home", "Away"].map(team => ({ team: { name: team }, playedGames: 0, points: 0 })) }],
    });
    assert.equal(model.tablesLive, false, stage);
    assert.ok(model.tables[0].rows.every(row => row.points === 0 && row.played === 0), stage);
  }
});

test("league-phase live results still update the table", () => {
  const model = buildModel({
    competition: "CL", matches: [fixture(1, "LEAGUE_STAGE", "Home", "Away", "IN_PLAY")],
    standings: [{ type: "TOTAL", table: ["Home", "Away"].map(team => ({ team: { name: team }, playedGames: 0, points: 0 })) }],
  });
  assert.equal(model.tablesLive, true);
  assert.equal(model.tables[0].rows[0].points, 3);
});

test("the hero reflects the live matchday instead of the next matchday", () => {
  const model = { competition: { name: "Champions League" }, matches: [
    fixture(1, "LEAGUE_STAGE", "Home", "Away", "IN_PLAY"),
    { ...fixture(2, "LEAGUE_STAGE", "Home", "Away", "TIMED"), matchday: 2 },
  ] };
  assert.match(renderHero(model), /Matchday 1/);
  model.matches[1].status = "IN_PLAY";
  assert.match(renderHero(model), /Live scores & table/, "mixed live matchdays must not claim one round");
});

test("qualifying play-offs and knockout play-offs have distinct labels", () => {
  assert.equal(formatStage("PLAYOFFS"), "Qualifying play-offs");
  assert.equal(formatStage("PLAYOFF_ROUND"), "Knockout play-offs");
  const model = { competition: { code: "CL" }, matches: [fixture(1, "PLAYOFFS", "Home", "Away"), fixture(2, "PLAYOFF_ROUND", "Home", "Away")] };
  assert.match(renderKnockout(model, { phase: "qualifying" }), /Qualifying play-offs/);
  assert.doesNotMatch(renderKnockout(model, { phase: "qualifying" }), /Knockout play-offs/);
  assert.match(renderKnockout(model), /Knockout play-offs/);
});

test("half-time and interruptions survive mapping and model construction with distinct labels", () => {
  for (const [short, label] of [["HT", "HT"], ["SUSP", "Suspended"], ["INT", "Interrupted"]]) {
    const payload = { response: [{ fixture: { id: 1, status: { short, elapsed: 45 } }, teams: {} }] };
    const matches = mapApiFootballMatches(payload);
    const model = buildModel({ competition: "CL", matches, standings: [] });
    assert.equal(statusLabel(model.matches[0]), label);
    assert.equal(statusLabel(mapApiFootballMatchDetail(payload, {}, {}, {})), label);
    assert.match(renderLive(model), new RegExp(label));
  }
  assert.equal(statusLabel({ status: "PAUSED", minute: 45 }), "Paused", "old payloads cannot identify the reason for a pause");
});
