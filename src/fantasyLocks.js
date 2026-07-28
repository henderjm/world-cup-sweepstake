// Pure player-lock logic (waivers hardening). No DOM, no fetch: the Worker's
// instant free-agent route is a thin shell around these functions, mirroring
// how fantasyGameweek.js and fantasyWaivers.js keep their rules unit-tested
// outside the Worker.
//
// The exploit this closes: instant free-agent adds had no lock of any kind,
// so a manager could add (or drop) a player mid-gameweek AFTER his club's
// match had already banked (or ruined) his fantasy points, since the scoring
// cron recomputes each gameweek's rollup from whoever is CURRENTLY on a
// manager's roster/lineup, never who was there at kickoff. ESPN's model locks
// each player individually at their own real-world kickoff instead of one
// league-wide deadline; this module is the same rule.
//
// Scope, deliberately narrow: only the instant free-agency path needs this
// (see worker.js's handleFantasyFreeAgentAdd and CLAUDE.md). Waiver claims
// are submitted mid-gameweek but RESOLVE after the gameweek's settlement
// buffer (runScheduledWaiverRuns), by which point every match in the settled
// gameweek is already terminal by construction. Applying this lock to claim
// resolution would therefore reject every processed claim, not just late
// ones, so it is intentionally only wired into the instant-add route; what
// protects a late claim instead is the quiet period in fantasyWaivers.js,
// which defers it to the next run rather than rejecting it.

import { gameweekOf, toEpochMs } from "./fantasyCalendar.js";
import { isFinished, isLive } from "./format.js";

// One club's lock state for one gameweek. `team` is a normalized team name
// (see normalizeTeamName/domain.js, the same join key matches and players
// already share); `matches` is the mapped match list (mapApiFootball.js),
// ideally already run through assignGameweeks so a replayed fixture is judged
// in the window it was actually played in; `gameweek` is the window in
// question; `now` is injected (anything `new Date()` accepts, including a Date
// or epoch ms) so this stays pure and deterministic - it never reads the clock
// itself.
//
// A club can have more than one fixture in a window (a double gameweek: a
// postponed match replayed inside a later window). The club is locked once ANY
// of them has kicked off, because from that moment some of the gameweek's
// points are already on the board and an add or drop would be retroactive. The
// returned `kickoff` is the earliest of the club's fixtures in the window, so
// the UI counts down to the first one rather than the last.
//
// Returns { locked, kickoff, reason }:
//   - No fixture for `team` in `gameweek` (a blank gameweek: the club plays no
//     match inside this window, e.g. a postponed fixture that has moved out of
//     it) is NOT locked - there is nothing to have banked or lost points from.
//   - A live or finished fixture (isLive/isFinished, src/format.js's own
//     status vocabulary, same as gameweekStatus in fantasyGameweek.js) is
//     always locked, regardless of the clock: this is the "actually kicked
//     off" signal of record.
//   - A postponed or cancelled fixture is never a kickoff by itself, even
//     once its originally scheduled utcDate has passed: POSTPONED means the
//     game never happened at that slot, and CANCELLED (which also covers an
//     abandoned match, see mapApiFootball.js's ABD mapping) means either it
//     never happened or was already caught live/finished above while still
//     in progress. Neither status reaches this branch with real points on
//     the board, so the clock comparison is skipped for both.
//   - Otherwise (a plain pre-match status: TIMED/SCHEDULED), locked once
//     `now` is at or past the fixture's utcDate.
export function playerLockState({ team, matches, gameweek, now }) {
  const fixtures = (matches ?? []).filter(
    (match) => gameweekOf(match) === gameweek && (match.homeTeam === team || match.awayTeam === team),
  );
  if (!fixtures.length) return { locked: false, kickoff: null, reason: "no fixture this gameweek" };

  const states = fixtures.map((fixture) => fixtureLockState(fixture, now));
  const locked = states.find((state) => state.locked);
  const kickoff = earliestKickoff(fixtures);
  if (locked) return { locked: true, kickoff, reason: locked.reason };
  return { locked: false, kickoff, reason: states[0].reason };
}

function fixtureLockState(fixture, now) {
  const kickoff = fixture.utcDate ?? null;
  if (isLive(fixture.status)) return { locked: true, reason: "live" };
  if (isFinished(fixture.status)) return { locked: true, reason: "finished" };
  if (fixture.status === "POSTPONED" || fixture.status === "CANCELLED") {
    return { locked: false, reason: "postponed or cancelled" };
  }
  const nowMs = toEpochMs(now);
  const kickoffMs = toEpochMs(kickoff);
  const started = Number.isFinite(nowMs) && Number.isFinite(kickoffMs) && kickoffMs <= nowMs;
  return started ? { locked: true, reason: "kicked off" } : { locked: false, reason: "not kicked off" };
}

function earliestKickoff(fixtures) {
  let earliest = null;
  let earliestMs = Infinity;
  for (const fixture of fixtures) {
    const ms = toEpochMs(fixture.utcDate);
    if (!Number.isFinite(ms)) continue;
    if (ms < earliestMs) {
      earliestMs = ms;
      earliest = fixture.utcDate;
    }
  }
  return earliest ?? fixtures[0]?.utcDate ?? null;
}

// Maps a player list to the Set of ids whose club has kicked off in
// `gameweek`, so the Worker route and the waivers-panel UI can share one
// derivation instead of each re-walking playerLockState. `players` is
// [{ id, team }, ...]; a player missing an id is skipped rather than throwing.
export function lockedPlayerIds(players, matches, gameweek, now) {
  const locked = new Set();
  for (const player of players ?? []) {
    if (player?.id == null) continue;
    if (playerLockState({ team: player.team, matches, gameweek, now }).locked) locked.add(player.id);
  }
  return locked;
}

// Every player whose situation this lineup edit would actually change: added
// to the XI, dropped out of it, or gaining or losing the armband. Only these
// need a lock check, so a manager is never blocked from reshuffling players
// who have not kicked off yet just because someone else in their squad has.
//
// BOTH directions matter, which is the easy half to get wrong. Starting a
// player who has already scored is the obvious cheat, but benching one who has
// already blanked is exactly as valuable and exactly as retroactive. So is
// moving the armband onto a hat-trick that is already on the board. A check
// that only guarded additions would leave two thirds of the exploit open.
//
// Ids are compared as-is; callers pass numbers on both sides (the route
// coerces the request body with Number before this is reached).
export function lineupChangedPlayerIds({
  previousStarterIds = [],
  previousCaptainId = null,
  nextStarterIds = [],
  nextCaptainId = null,
} = {}) {
  const before = new Set(previousStarterIds);
  const after = new Set(nextStarterIds);
  const changed = new Set();

  for (const id of after) if (!before.has(id)) changed.add(id);
  for (const id of before) if (!after.has(id)) changed.add(id);

  if (previousCaptainId !== nextCaptainId) {
    if (previousCaptainId != null) changed.add(previousCaptainId);
    if (nextCaptainId != null) changed.add(nextCaptainId);
  }
  return changed;
}
