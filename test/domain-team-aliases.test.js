import assert from "node:assert/strict";
import test from "node:test";

import { normalizeTeamName } from "../src/domain.js";

// data/PL/players.json's fetch script (scripts/fetch-fantasy-players.mjs) gets
// the short club name back from API-Football's /players/squads endpoint for
// these three 2026/27 promoted clubs, while the fixtures endpoint (and
// badges.js's LOCAL_CRESTS) use the long form. Without these aliases the two
// static files disagree on the join key, which silently breaks any feature
// that joins a player to their club's fixture (src/fantasyDemoFixtures.js,
// src/fantasyLocks.js).
test("normalizeTeamName maps the short forms of the three promoted clubs to their canonical long form", () => {
  assert.equal(normalizeTeamName("Coventry"), "Coventry City");
  assert.equal(normalizeTeamName("Ipswich"), "Ipswich Town");
  assert.equal(normalizeTeamName("Leeds"), "Leeds United");
});

test("normalizeTeamName leaves the canonical long forms themselves unchanged", () => {
  assert.equal(normalizeTeamName("Coventry City"), "Coventry City");
  assert.equal(normalizeTeamName("Ipswich Town"), "Ipswich Town");
  assert.equal(normalizeTeamName("Leeds United"), "Leeds United");
});

test("normalizeTeamName alias matching is case-insensitive, matching every other alias in the map", () => {
  assert.equal(normalizeTeamName("coventry"), "Coventry City");
  assert.equal(normalizeTeamName("LEEDS"), "Leeds United");
});
