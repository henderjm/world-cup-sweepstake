import assert from "node:assert/strict";
import test from "node:test";

import {
  championMember,
  eligibleChampions,
  isChampionId,
  validateChampionChoice,
  withChampionFlags,
} from "../src/fantasyChampion.js";

const MEMBERS = [
  { userId: 3, name: "Rory", isBot: false },
  { userId: 1, name: "Ada", isBot: false },
  { userId: 7, name: "Bot Casillas", isBot: true },
];

test("a bot manager is never offered as the previous winner", () => {
  // A bot seat is created for THIS league while it is still pending, so it did
  // not exist during any previous season.
  const names = eligibleChampions(MEMBERS).map((member) => member.name);
  assert.deepEqual(names, ["Ada", "Rory"]);
});

test("eligibleChampions does not mutate or reorder the caller's array", () => {
  const input = [...MEMBERS];
  eligibleChampions(input);
  assert.deepEqual(
    input.map((member) => member.userId),
    [3, 1, 7],
  );
});

test("no champion, and the Average opponent's sentinel, both read as false", () => {
  // AVERAGE_USER_ID is 0 (src/fantasyAverage.js) and real ids are always >= 1,
  // so a naive equality check would hand Average a trophy in an odd league.
  assert.equal(isChampionId(0, null), false);
  assert.equal(isChampionId(0, 0), false);
  assert.equal(isChampionId(1, null), false);
  assert.equal(isChampionId(1, undefined), false);
  assert.equal(isChampionId(1, 1), true);
});

test("a champion who has left the league is nobody rather than a stale name", () => {
  assert.equal(championMember(MEMBERS, 3).name, "Rory");
  assert.equal(championMember(MEMBERS, 99), null);
  assert.equal(championMember(MEMBERS, null), null);
});

test("withChampionFlags stamps exactly one holder and leaves the rest untouched", () => {
  const flagged = withChampionFlags(MEMBERS, 3);
  assert.deepEqual(
    flagged.map((member) => member.isChampion),
    [true, false, false],
  );
  // The rest of each row survives: these are the same objects every renderer
  // reads for names and bot chips.
  assert.equal(flagged[2].name, "Bot Casillas");
  assert.equal(flagged[2].isBot, true);
  assert.equal(withChampionFlags(MEMBERS, null).every((member) => !member.isChampion), true);
  assert.deepEqual(withChampionFlags(null, 3), []);
});

test("a commissioner cannot name a stranger, a bot, or nothing at all", () => {
  assert.deepEqual(validateChampionChoice(MEMBERS, 1), { valid: true, userId: 1 });
  // The picker submits strings; a numeric string is the normal case, not an edge one.
  assert.deepEqual(validateChampionChoice(MEMBERS, "3"), { valid: true, userId: 3 });

  assert.equal(validateChampionChoice(MEMBERS, 99).valid, false);
  assert.equal(validateChampionChoice(MEMBERS, 7).valid, false, "a bot cannot hold last season's trophy");
  for (const bad of [null, undefined, "", "nobody", 0, -1, 1.5, NaN]) {
    assert.equal(validateChampionChoice(MEMBERS, bad).valid, false, `${String(bad)} was accepted`);
  }
});

test("every rejection carries a message written for a person to read", () => {
  for (const bad of [99, 7, ""]) {
    const result = validateChampionChoice(MEMBERS, bad);
    assert.equal(result.valid, false);
    assert.equal(typeof result.error, "string");
    assert.ok(result.error.length > 0);
    assert.doesNotMatch(result.error, /undefined|NaN|\[object/);
  }
});
