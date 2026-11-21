import { test } from "node:test";
import assert from "node:assert/strict";
import { clubLeaderboard, findParticipantId, formatStat, mapSquadStats, squadLine } from "../src/sportmonksSquad.js";

// Trimmed from Inter's Serie A 2026/27 squad, 21 November 2026.
const SEASON = 27895;
const squad = [
  { player_id: 1, team_id: 2930, position_id: 27, jersey_number: 10, player: { display_name: "Lautaro Martínez", image_path: "l.png", statistics: [
    { season_id: SEASON, team_id: 2930, details: [{ type_id: 52, value: { total: 9 } }, { type_id: 321, value: { total: 12 } }, { type_id: 119, value: { total: 1010 } }, { type_id: 118, value: { average: 7.31 } }, { type_id: 5304, value: { expected: 4.8058, actual: 4, difference: -0.806 } }] },
  ] } },
  { player_id: 2, team_id: 2930, position_id: 26, jersey_number: 23, player: { display_name: "Barella", statistics: [
    { season_id: SEASON, team_id: 2930, details: [{ type_id: 79, value: { total: 4 } }, { type_id: 321, value: { total: 11 } }, { type_id: 119, value: { total: 900 } }, { type_id: 118, value: { average: 7.02 } }] },
  ] } },
  { player_id: 3, team_id: 2930, position_id: 24, jersey_number: 99, player: { display_name: "Cameo Keeper", statistics: [
    { season_id: SEASON, team_id: 2930, details: [{ type_id: 321, value: { total: 1 } }, { type_id: 118, value: { average: 8.9 } }] },
  ] } },
];

test("a squad maps to players with season stats keyed by type id", () => {
  const players = mapSquadStats(squad, SEASON);
  assert.equal(players.length, 3);
  assert.deepEqual(players[0], { playerId: 1, name: "Lautaro Martínez", image: "l.png", pos: "F", num: 10, stats: { 52: 9, 321: 12, 119: 1010, 118: 7.31, 5304: 4.8058 } });
});

test("a leaderboard leaves out players without the figure instead of ranking them 0", () => {
  const players = mapSquadStats(squad, SEASON);
  assert.deepEqual(clubLeaderboard(players, "goals").map(p => p.name), ["Lautaro Martínez"]);
  assert.deepEqual(clubLeaderboard(players, "assists").map(p => p.value), [4]);
});

test("rating needs a few appearances, so one cameo cannot top the club", () => {
  const players = mapSquadStats(squad, SEASON);
  assert.deepEqual(clubLeaderboard(players, "rating").map(p => p.name), ["Lautaro Martínez", "Barella"]);
  assert.equal(formatStat("rating", 7.3), "7.30");
  assert.equal(squadLine(players[0]), "12 apps · 1010'");
});

test("the club is found by canonical name, and an ambiguous or unknown name finds nothing", () => {
  const standings = [{ participant_id: 2930, participant: { name: "Inter" } }, { participant_id: 7, participant: { name: "AC Milan" } }];
  assert.equal(findParticipantId(standings, "Inter"), 2930);
  assert.equal(findParticipantId(standings, "Napoli"), null);
  assert.equal(findParticipantId(standings, ""), null);
});

test("season xG (expected, not actual goals) is a sortable figure", () => {
  const players = mapSquadStats(squad, SEASON);
  assert.deepEqual(clubLeaderboard(players, "xg").map(p => [p.name, formatStat("xg", p.value)]), [["Lautaro Martínez", "4.81"]]);
});
