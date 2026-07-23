import assert from "node:assert/strict";
import test from "node:test";

import { defaultLineup, resolveEffectiveLineup, validateLineupSelection } from "../src/fantasyLineups.js";
import { STARTING_SIZE, validateFormation } from "../src/fantasy.js";

// A standard 2 GK / 5 DEF / 5 MID / 3 FWD (15-player) roster, ids 1..15 in
// squad order, matching SQUAD_SLOTS exactly.
function standardRoster() {
  const roster = [];
  let id = 1;
  const add = (position, count) => {
    for (let i = 0; i < count; i++) roster.push({ id: id++, name: `Player ${id}`, team: "Test", position });
  };
  add("GK", 2);
  add("DEF", 5);
  add("MID", 5);
  add("FWD", 3);
  return roster;
}

// -- resolveEffectiveLineup ----------------------------------------------------

test("resolveEffectiveLineup returns the exact gameweek's rows when they exist", () => {
  const rows = [
    { gameweek: 3, player_id: 1, is_captain: 0 },
    { gameweek: 5, player_id: 2, is_captain: 1 },
    { gameweek: 5, player_id: 3, is_captain: 0 },
  ];
  const result = resolveEffectiveLineup(rows, 5);
  assert.deepEqual(result, {
    gameweek: 5,
    inherited: false,
    starters: [
      { playerId: 2, isCaptain: true },
      { playerId: 3, isCaptain: false },
    ],
  });
});

test("resolveEffectiveLineup inherits the latest earlier gameweek when none is set", () => {
  const rows = [
    { gameweek: 2, player_id: 1, is_captain: 1 },
    { gameweek: 4, player_id: 5, is_captain: 1 },
    { gameweek: 4, player_id: 6, is_captain: 0 },
  ];
  const result = resolveEffectiveLineup(rows, 7);
  assert.deepEqual(result, {
    gameweek: 4,
    inherited: true,
    starters: [
      { playerId: 5, isCaptain: true },
      { playerId: 6, isCaptain: false },
    ],
  });
});

test("resolveEffectiveLineup returns null gameweek when no rows exist at all", () => {
  const result = resolveEffectiveLineup([], 1);
  assert.deepEqual(result, { gameweek: null, inherited: false, starters: [] });
});

test("resolveEffectiveLineup ignores rows for later gameweeks when inheriting", () => {
  const rows = [
    { gameweek: 2, player_id: 1, is_captain: 1 },
    { gameweek: 9, player_id: 9, is_captain: 1 }, // later than the requested gameweek
  ];
  const result = resolveEffectiveLineup(rows, 3);
  assert.deepEqual(result, {
    gameweek: 2,
    inherited: true,
    starters: [{ playerId: 1, isCaptain: true }],
  });
});

// -- defaultLineup --------------------------------------------------------------

test("defaultLineup produces a legal, full starting XI for a standard 2/5/5/3 roster", () => {
  const roster = standardRoster();
  const { starters, captainId } = defaultLineup(roster);

  assert.equal(starters.length, STARTING_SIZE);
  const ids = starters.map((entry) => entry.playerId);
  assert.equal(new Set(ids).size, ids.length); // no duplicates

  const byId = new Map(roster.map((player) => [player.id, player]));
  const positions = ids.map((id) => byId.get(id).position);
  assert.equal(validateFormation(positions).valid, true);

  assert.equal(starters.filter((entry) => entry.isCaptain).length, 1);
  assert.equal(captainId, starters[0].playerId);
  assert.equal(starters.find((entry) => entry.playerId === captainId).isCaptain, true);
});

test("defaultLineup is deterministic across calls on the same roster", () => {
  const roster = standardRoster();
  assert.deepEqual(defaultLineup(roster), defaultLineup(roster));
});

test("defaultLineup returns an empty result for an empty roster", () => {
  assert.deepEqual(defaultLineup([]), { starters: [], captainId: null });
});

// -- validateLineupSelection -----------------------------------------------------

function legalSelection(roster) {
  const { starters, captainId } = defaultLineup(roster);
  return { starters: starters.map((entry) => entry.playerId), captainId };
}

test("validateLineupSelection accepts a legal, fully-owned starting XI", () => {
  const roster = standardRoster();
  const selection = legalSelection(roster);
  assert.deepEqual(validateLineupSelection({ ...selection, roster }), { ok: true });
});

test("validateLineupSelection rejects the wrong number of starters", () => {
  const roster = standardRoster();
  const { starters, captainId } = legalSelection(roster);
  const result = validateLineupSelection({ starters: starters.slice(0, 10), captainId, roster });
  assert.equal(result.ok, false);
  assert.match(result.error, /exactly/);
});

test("validateLineupSelection rejects a player not on the roster", () => {
  const roster = standardRoster();
  const { starters, captainId } = legalSelection(roster);
  const withImposter = [...starters.slice(0, 10), 999];
  const result = validateLineupSelection({ starters: withImposter, captainId, roster });
  assert.equal(result.ok, false);
  assert.match(result.error, /not on your roster/);
});

test("validateLineupSelection rejects a formation with zero goalkeepers", () => {
  const roster = standardRoster();
  // 10 outfield players (5 DEF, 5 MID... trimmed to fit STARTING_SIZE with no GK)
  // plus one more outfield player instead of a keeper.
  const outfield = roster.filter((player) => player.position !== "GK");
  const starters = outfield.slice(0, STARTING_SIZE).map((player) => player.id);
  const result = validateLineupSelection({ starters, captainId: starters[0], roster });
  assert.equal(result.ok, false);
  assert.match(result.error, /GK/);
});

test("validateLineupSelection rejects a formation with too many defenders", () => {
  const roster = standardRoster();
  const gks = roster.filter((player) => player.position === "GK").slice(0, 1);
  // The standard roster only has 5 defenders (the STARTING_LIMITS max), so a
  // 6th is added here purely to make "too many DEF" reachable at all.
  const extendedRoster = [...roster, { id: 100, name: "Extra Def", team: "Test", position: "DEF" }];
  const sixDefs = extendedRoster.filter((player) => player.position === "DEF").slice(0, 6);
  const fwd = extendedRoster.filter((player) => player.position === "FWD").slice(0, 1);
  const mid = extendedRoster.filter((player) => player.position === "MID").slice(0, STARTING_SIZE - 6 - 1 - 1);
  const starters = [...gks, ...sixDefs, ...mid, ...fwd].map((player) => player.id);
  assert.equal(starters.length, STARTING_SIZE);
  const result = validateLineupSelection({ starters, captainId: starters[0], roster: extendedRoster });
  assert.equal(result.ok, false);
  assert.match(result.error, /DEF/);
});

test("validateLineupSelection rejects a captain who is not among the starters", () => {
  const roster = standardRoster();
  const { starters } = legalSelection(roster);
  const outsider = roster.find((player) => !starters.includes(player.id));
  const result = validateLineupSelection({ starters, captainId: outsider.id, roster });
  assert.equal(result.ok, false);
  assert.match(result.error, /captain/);
});

test("validateLineupSelection rejects duplicate starter ids", () => {
  const roster = standardRoster();
  const { starters, captainId } = legalSelection(roster);
  const duplicated = [...starters.slice(0, STARTING_SIZE - 1), starters[0]];
  const result = validateLineupSelection({ starters: duplicated, captainId, roster });
  assert.equal(result.ok, false);
  assert.match(result.error, /duplicate/);
});
