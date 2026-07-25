import assert from "node:assert/strict";
import test from "node:test";

import { lockedPlayerIds, playerLockState } from "../src/fantasyLocks.js";

const NOW = new Date("2026-08-16T15:00:00Z").getTime();

function match({ team = "Man City", opponent = "Arsenal", matchday = 3, status = "TIMED", utcDate }) {
  return {
    matchday,
    status,
    utcDate: utcDate ?? new Date("2026-08-16T14:00:00Z").toISOString(),
    homeTeam: team,
    awayTeam: opponent,
  };
}

// -- playerLockState -----------------------------------------------------------

test("playerLockState is not locked when the fixture has not kicked off yet", () => {
  const matches = [match({ status: "TIMED", utcDate: new Date(NOW + 60 * 60 * 1000).toISOString() })];
  const result = playerLockState({ team: "Man City", matches, gameweek: 3, now: NOW });
  assert.equal(result.locked, false);
  assert.equal(result.reason, "not kicked off");
  assert.ok(result.kickoff);
});

test("playerLockState locks once the scheduled kickoff time has passed, even if status is still stale", () => {
  const matches = [match({ status: "TIMED", utcDate: new Date(NOW - 60 * 1000).toISOString() })];
  const result = playerLockState({ team: "Man City", matches, gameweek: 3, now: NOW });
  assert.equal(result.locked, true);
  assert.equal(result.reason, "kicked off");
});

test("playerLockState locks on a live status regardless of the clock", () => {
  // utcDate deliberately in the future relative to `now` (clock skew / a
  // delayed kickoff logged late): the live status must still win.
  const matches = [match({ status: "IN_PLAY", utcDate: new Date(NOW + 60 * 60 * 1000).toISOString() })];
  const result = playerLockState({ team: "Man City", matches, gameweek: 3, now: NOW });
  assert.equal(result.locked, true);
  assert.equal(result.reason, "live");
});

test("playerLockState locks a finished fixture", () => {
  const matches = [match({ status: "FINISHED" })];
  const result = playerLockState({ team: "Man City", matches, gameweek: 3, now: NOW });
  assert.equal(result.locked, true);
  assert.equal(result.reason, "finished");
});

test("playerLockState treats a blank gameweek (no fixture at all) as not locked", () => {
  const matches = [match({ matchday: 4 })]; // a different gameweek only
  const result = playerLockState({ team: "Man City", matches, gameweek: 3, now: NOW });
  assert.equal(result.locked, false);
  assert.equal(result.reason, "no fixture this gameweek");
  assert.equal(result.kickoff, null);
});

test("playerLockState does not lock a postponed fixture even once its original kickoff time has passed", () => {
  const matches = [match({ status: "POSTPONED", utcDate: new Date(NOW - 60 * 60 * 1000).toISOString() })];
  const result = playerLockState({ team: "Man City", matches, gameweek: 3, now: NOW });
  assert.equal(result.locked, false);
  assert.equal(result.reason, "postponed or cancelled");
});

test("playerLockState does not lock a cancelled fixture even once its original kickoff time has passed", () => {
  const matches = [match({ status: "CANCELLED", utcDate: new Date(NOW - 60 * 60 * 1000).toISOString() })];
  const result = playerLockState({ team: "Man City", matches, gameweek: 3, now: NOW });
  assert.equal(result.locked, false);
  assert.equal(result.reason, "postponed or cancelled");
});

test("playerLockState is deterministic: identical input always produces the identical result", () => {
  const matches = [match({ status: "IN_PLAY" })];
  const a = playerLockState({ team: "Man City", matches, gameweek: 3, now: NOW });
  const b = playerLockState({ team: "Man City", matches, gameweek: 3, now: NOW });
  assert.deepEqual(a, b);
});

test("playerLockState accepts a Date object or an ISO string for `now`, not just epoch ms", () => {
  const matches = [match({ status: "TIMED", utcDate: new Date(NOW - 1000).toISOString() })];
  const withDate = playerLockState({ team: "Man City", matches, gameweek: 3, now: new Date(NOW) });
  const withIso = playerLockState({ team: "Man City", matches, gameweek: 3, now: new Date(NOW).toISOString() });
  assert.equal(withDate.locked, true);
  assert.equal(withIso.locked, true);
});

test("playerLockState only matches the fixture for the requested team, home or away", () => {
  const matches = [match({ team: "Man City", opponent: "Arsenal", status: "FINISHED" })];
  assert.equal(playerLockState({ team: "Man City", matches, gameweek: 3, now: NOW }).locked, true);
  assert.equal(playerLockState({ team: "Arsenal", matches, gameweek: 3, now: NOW }).locked, true);
  assert.equal(playerLockState({ team: "Chelsea", matches, gameweek: 3, now: NOW }).locked, false);
});

// -- lockedPlayerIds -----------------------------------------------------------

test("lockedPlayerIds maps a player list to the set of ids whose club has kicked off", () => {
  const matches = [
    match({ team: "Man City", opponent: "Arsenal", status: "FINISHED" }),
    match({ team: "Chelsea", opponent: "Everton", status: "TIMED", utcDate: new Date(NOW + 60 * 60 * 1000).toISOString() }),
  ];
  const players = [
    { id: 1, team: "Man City" }, // locked, finished
    { id: 2, team: "Arsenal" }, // locked, finished (away side of the same fixture)
    { id: 3, team: "Chelsea" }, // not locked, not kicked off
    { id: 4, team: "Everton" }, // not locked
    { id: 5, team: "Brentford" }, // not locked, no fixture at all
  ];
  const locked = lockedPlayerIds(players, matches, 3, NOW);
  assert.deepEqual([...locked].sort((a, b) => a - b), [1, 2]);
});

test("lockedPlayerIds skips a player with no id rather than throwing", () => {
  const matches = [match({ status: "FINISHED" })];
  const locked = lockedPlayerIds([{ team: "Man City" }, { id: 9, team: "Man City" }], matches, 3, NOW);
  assert.deepEqual([...locked], [9]);
});

test("lockedPlayerIds returns an empty set for an empty or missing player list", () => {
  const matches = [match({ status: "FINISHED" })];
  assert.deepEqual(lockedPlayerIds([], matches, 3, NOW), new Set());
  assert.deepEqual(lockedPlayerIds(undefined, matches, 3, NOW), new Set());
});
