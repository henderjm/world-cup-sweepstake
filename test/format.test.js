import assert from "node:assert/strict";
import test from "node:test";

import { UNKNOWN_POSITION_RANK, byPosition, positionRank } from "../src/format.js";

test("positionRank orders keeper, defence, midfield, attack", () => {
  assert.deepEqual(["GK", "DEF", "MID", "FWD"].map(positionRank), [0, 1, 2, 3]);
});

test("positionRank reads every position spelling the app actually receives", () => {
  // API-Football (what the Worker and the bake serve today).
  assert.deepEqual(["G", "D", "M", "F"].map(positionRank), [0, 1, 2, 3]);
  // football-data.org era, still in the committed seed files.
  assert.deepEqual(["Goalkeeper", "Defence", "Midfield", "Offence"].map(positionRank), [0, 1, 2, 3]);
  // Both spellings of an attacker, and the abbreviations the drawer shows.
  assert.deepEqual(["Attacker", "Defender", "Midfielder"].map(positionRank), [3, 1, 2]);
  assert.deepEqual(["DF", "MF", "FW"].map(positionRank), [1, 2, 3]);
  // Case and stray whitespace are not a different position.
  assert.equal(positionRank(" gk "), 0);
});

test("positionRank sorts an unknown or missing position last, never first", () => {
  for (const value of [null, undefined, "", "   ", "Unknown", 7]) {
    assert.equal(positionRank(value), UNKNOWN_POSITION_RANK);
    assert.ok(positionRank(value) > positionRank("GK"));
  }
});

test("byPosition reads either field name, so one comparator serves both benches", () => {
  const fantasy = [{ position: "FWD" }, { position: "GK" }];
  const feed = [{ pos: "F" }, { pos: "G" }];
  assert.ok(byPosition(fantasy[0], fantasy[1]) > 0);
  assert.ok(byPosition(feed[0], feed[1]) > 0);
});

test("byPosition is stable, so players sharing a position keep their arrival order", () => {
  const bench = [
    { name: "Third", pos: "M" },
    { name: "Keeper", pos: "G" },
    { name: "First", pos: "D" },
    { name: "Second", pos: "D" },
    { name: "Unlabelled", pos: null },
    { name: "Striker", pos: "F" },
  ];

  assert.deepEqual(
    [...bench].sort(byPosition).map((player) => player.name),
    ["Keeper", "First", "Second", "Third", "Striker", "Unlabelled"],
  );
});
