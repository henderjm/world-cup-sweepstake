import { test } from "node:test";
import assert from "node:assert/strict";
import { mapMatchCentre, mapPredictions } from "../src/sportmonks.js";
import { mapSportmonksDetail } from "../src/sportmonksFeed.js";
import { COMPETITIONS, SPORTMONKS_COMPETITION_CODES } from "../src/competitions.js";

// Shapes trimmed from the live API, 21 November 2026 (Manchester City v
// Fulham pre-match; Liverpool v Arsenal after full time).
const participants = [
  { id: 9, name: "Manchester City", meta: { location: "home" } },
  { id: 11, name: "Fulham", meta: { location: "away" } },
];

test("predictions map to rounded model percentages and skip the 'other' score bucket", () => {
  const model = mapPredictions({
    participants,
    predictions: [
      { type_id: 33, predictions: { bet: "1", bookmaker: "1xbet", odd: 1.45 } },
      { type_id: 237, predictions: { home: 59.93, away: 18.42, draw: 21.61 } },
      { type_id: 231, predictions: { yes: 52.9, no: 47.1 } },
      { type_id: 235, predictions: { yes: 56.8, no: 43.2 } },
      { type_id: 240, predictions: { scores: { Other_1: 13.93, "1-0": 11, "2-0": 9.9 } } },
    ],
  });
  assert.deepEqual(model, { home: 60, draw: 22, away: 18, btts: 53, over25: 57, likelyScore: { score: "1-0", chance: 11 } });
  assert.equal(JSON.stringify(model).includes("1xbet"), false, "bookmaker odds never leave the mapper");
});

test("no result probability means no model at all, never a made-up split", () => {
  assert.equal(mapPredictions({ predictions: [{ type_id: 231, predictions: { yes: 50 } }] }), null);
  assert.equal(mapPredictions(null), null);
});

test("the centre carries coaches, attendance and kit colours on the right side", () => {
  const centre = mapMatchCentre({
    id: 1,
    participants,
    coaches: [
      { display_name: "Enzo Maresca", meta: { participant_id: 9 } },
      { display_name: "Arbeloa", meta: { participant_id: 11 } },
    ],
    metadata: [
      { type_id: 161, values: { participant: "#C40010", kit: "#C40010,#C40010" } },
      { type_id: 162, values: { participant: "not-a-colour" } },
      { type_id: 578, values: { attendance: 60406 } },
    ],
  });
  assert.deepEqual(centre.coaches, { home: "Enzo Maresca", away: "Arbeloa" });
  assert.equal(centre.attendance, 60406);
  assert.deepEqual(centre.colours, { home: "#C40010", away: null });
});

test("missing attendance is null, never 0", () => {
  assert.equal(mapMatchCentre({ id: 1, participants, metadata: [] }).attendance, null);
});

test("Serie A / La Liga player stats are real figures, and absent ones stay null", () => {
  const detail = mapSportmonksDetail({
    id: 5,
    participants,
    state: { developer_name: "FT" },
    coaches: [{ display_name: "Enzo Maresca", meta: { participant_id: 9 } }],
    metadata: [{ type_id: 578, values: { attendance: 52000 } }],
    lineups: [{
      player_id: 7, player_name: "Foden", team_id: 9, type_id: 11, position_id: 26,
      details: [
        { type_id: 119, data: { value: 90 } }, { type_id: 118, data: { value: 7.4 } },
        { type_id: 78, data: { value: 3 } }, { type_id: 42, data: { value: 0 } }, { type_id: 117, data: { value: 2 } },
      ],
    }],
  });
  const [player] = detail.playerStats;
  assert.equal(player.tackles, 3);
  assert.equal(player.shots, 0, "a real zero stays zero");
  assert.equal(player.keyPasses, 2);
  assert.equal(player.interceptions, null, "not sent means unknown, not 0");
  assert.equal(detail.home.coach, "Enzo Maresca");
  assert.equal(detail.away.coach, null);
  assert.equal(detail.attendance, 52000);
});

test("Europa and Conference League are Sportmonks-served 36-team league phases", () => {
  assert.ok(SPORTMONKS_COMPETITION_CODES.includes("EL"));
  assert.ok(SPORTMONKS_COMPETITION_CODES.includes("UECL"));
  assert.equal(COMPETITIONS.EL.sportmonksLeagueId, 5);
  assert.equal(COMPETITIONS.UECL.sportmonksLeagueId, 2286);
  assert.equal(COMPETITIONS.UECL.zones.at(-1).to, 36);
});
