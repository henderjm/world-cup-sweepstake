import assert from "node:assert/strict";
import test from "node:test";

import { lineupChangedPlayerIds, lockedPlayerIds, playerLockState } from "../src/fantasyLocks.js";

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

// -- lineupChangedPlayerIds: what a lineup edit actually touches --------------
//
// These guard the retroactive-lineup exploit: after Saturday's fixtures settle
// but before Monday's, a manager could rewrite their XI to start whoever
// already scored. Only players whose status changes need a lock check, and
// crucially that includes players being taken OUT, not just put in.

test("lineupChangedPlayerIds flags a player being added to the XI", () => {
  const changed = lineupChangedPlayerIds({
    previousStarterIds: [1, 2],
    nextStarterIds: [1, 2, 3],
    previousCaptainId: 1,
    nextCaptainId: 1,
  });
  assert.deepEqual([...changed], [3]);
});

test("lineupChangedPlayerIds flags a player being benched, since benching a blank is equally retroactive", () => {
  const changed = lineupChangedPlayerIds({
    previousStarterIds: [1, 2, 3],
    nextStarterIds: [1, 2],
    previousCaptainId: 1,
    nextCaptainId: 1,
  });
  assert.deepEqual([...changed], [3]);
});

test("lineupChangedPlayerIds flags both sides of a swap", () => {
  const changed = lineupChangedPlayerIds({
    previousStarterIds: [1, 2],
    nextStarterIds: [1, 3],
    previousCaptainId: 1,
    nextCaptainId: 1,
  });
  assert.deepEqual([...changed].sort((a, b) => a - b), [2, 3]);
});

test("lineupChangedPlayerIds flags both the old and new captain when the armband moves", () => {
  // Moving the armband onto a hat-trick already on the board is its own cheat,
  // even when the XI itself is untouched.
  const changed = lineupChangedPlayerIds({
    previousStarterIds: [1, 2],
    nextStarterIds: [1, 2],
    previousCaptainId: 1,
    nextCaptainId: 2,
  });
  assert.deepEqual([...changed].sort((a, b) => a - b), [1, 2]);
});

test("lineupChangedPlayerIds flags nobody when nothing actually changed", () => {
  // A no-op save must not be blocked just because someone in the XI has
  // already kicked off, or a manager could be locked out of their own team.
  const changed = lineupChangedPlayerIds({
    previousStarterIds: [1, 2, 3],
    nextStarterIds: [3, 2, 1],
    previousCaptainId: 2,
    nextCaptainId: 2,
  });
  assert.equal(changed.size, 0);
});

test("lineupChangedPlayerIds handles a first-ever lineup with no previous captain", () => {
  const changed = lineupChangedPlayerIds({
    previousStarterIds: [],
    previousCaptainId: null,
    nextStarterIds: [7],
    nextCaptainId: 7,
  });
  assert.deepEqual([...changed], [7]);
});

test("lineupChangedPlayerIds tolerates being called with nothing at all", () => {
  assert.equal(lineupChangedPlayerIds().size, 0);
});

// -- double gameweeks ----------------------------------------------------------

test("playerLockState locks a club as soon as EITHER of its two fixtures in a window has started", () => {
  // A double gameweek: a postponed fixture replayed inside a later window, so
  // the club plays twice. Points from the first are already on the board, so
  // an add or drop is retroactive even though the second has not kicked off.
  const matches = [
    { gameweek: 9, matchday: 3, status: "FINISHED", utcDate: new Date(NOW - 3 * 60 * 60 * 1000).toISOString(), homeTeam: "Man City", awayTeam: "Arsenal" },
    { gameweek: 9, matchday: 9, status: "TIMED", utcDate: new Date(NOW + 3 * 60 * 60 * 1000).toISOString(), homeTeam: "Everton", awayTeam: "Man City" },
  ];
  const result = playerLockState({ team: "Man City", matches, gameweek: 9, now: NOW });
  assert.equal(result.locked, true);
  assert.equal(result.reason, "finished");
});

test("playerLockState reports the earliest of a club's two fixtures as the kickoff to count down to", () => {
  const early = new Date(NOW + 2 * 60 * 60 * 1000).toISOString();
  const late = new Date(NOW + 50 * 60 * 60 * 1000).toISOString();
  const matches = [
    { gameweek: 9, status: "TIMED", utcDate: late, homeTeam: "Man City", awayTeam: "Arsenal" },
    { gameweek: 9, status: "TIMED", utcDate: early, homeTeam: "Everton", awayTeam: "Man City" },
  ];
  const result = playerLockState({ team: "Man City", matches, gameweek: 9, now: NOW });
  assert.equal(result.locked, false);
  assert.equal(result.kickoff, early);
});

test("playerLockState follows the assigned gameweek, not the provider matchday", () => {
  // The postponed-and-replayed fixture still carries matchday 3, but it was
  // played inside window 9 and that is the week its points belong to.
  const matches = [
    { gameweek: 9, matchday: 3, status: "FINISHED", utcDate: new Date(NOW - 60 * 60 * 1000).toISOString(), homeTeam: "Man City", awayTeam: "Arsenal" },
  ];
  assert.equal(playerLockState({ team: "Man City", matches, gameweek: 9, now: NOW }).locked, true);
  assert.equal(playerLockState({ team: "Man City", matches, gameweek: 3, now: NOW }).locked, false);
});

test("a blank gameweek is still never locked", () => {
  const matches = [
    { gameweek: 9, status: "FINISHED", utcDate: new Date(NOW - 60 * 60 * 1000).toISOString(), homeTeam: "Everton", awayTeam: "Arsenal" },
  ];
  const result = playerLockState({ team: "Man City", matches, gameweek: 9, now: NOW });
  assert.equal(result.locked, false);
  assert.equal(result.reason, "no fixture this gameweek");
});
