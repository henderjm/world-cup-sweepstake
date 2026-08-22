import test from "node:test";
import assert from "node:assert/strict";

import { pitchRows, renderLineup, surname } from "../src/matchDetail.js";

// The drawer's line-up pitch: formation rows from the provider's per-player
// grid ("row:col", row 1 the keeper). The rule under test is all-or-nothing:
// one unplaced starter and the drawn shape would lie about the formation, so
// the renderer falls back to the flat list instead.

const gk = { name: "Alisson Becker", num: 1, grid: "1:1" };
const back4 = [
  { name: "Trent Alexander-Arnold", num: 66, grid: "2:4" },
  { name: "Ibrahima Konaté", num: 5, grid: "2:3" },
  { name: "Virgil van Dijk", num: 4, grid: "2:2" },
  { name: "Andrew Robertson", num: 26, grid: "2:1" },
];

test("grid rows come out keeper first, each row ordered by column", () => {
  const rows = pitchRows([back4[0], gk, back4[1], back4[2], back4[3]]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].map((p) => p.num), [1]);
  assert.deepEqual(rows[1].map((p) => p.num), [26, 4, 5, 66]);
});

test("one starter without a grid means no pitch at all, never a ten-man shape", () => {
  assert.equal(pitchRows([gk, ...back4, { name: "Mohamed Salah", num: 11, grid: null }]), null);
});

test("an empty or missing lineup yields no pitch", () => {
  assert.equal(pitchRows([]), null);
  assert.equal(pitchRows(undefined), null);
});

test("a malformed grid value falls back rather than guessing a row", () => {
  assert.equal(pitchRows([{ ...gk, grid: "keeper" }]), null);
});

test("a fully gridded XI renders the pitch; one without grids keeps the flat list", () => {
  const team = (lineup) => ({ name: "Liverpool", formation: "4-1-4-1", coach: "Coach", lineup, bench: [] });
  const gridded = renderLineup(team([gk, ...back4].map((p, i) => ({ ...p }))));
  assert.match(gridded, /xi-pitch__row/);
  assert.match(gridded, /van Dijk/);
  const ungridded = renderLineup(team([{ name: "Alisson Becker", num: 1, pos: "G", grid: null }]));
  assert.match(ungridded, /xi__players/);
  assert.doesNotMatch(ungridded, /xi-pitch/);
});

test("surnames keep everything after the first word, so 'van Dijk' survives", () => {
  assert.equal(surname("Virgil van Dijk"), "van Dijk");
  assert.equal(surname("Konstantinos Tzolakis"), "Tzolakis");
  assert.equal(surname("Pelé"), "Pelé");
  assert.equal(surname(""), "");
  assert.equal(surname(null), "");
});
