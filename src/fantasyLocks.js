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
// are submitted mid-gameweek but RESOLVE at the gameweek boundary
// (runScheduledWaiverRuns), by which point every match in the settled
// gameweek is already terminal by construction (currentFantasyGameweek is
// the smallest matchday with an unsettled match, so the gameweek being
// resolved, currentGameweek - 1, has none left). Applying this lock to claim
// resolution would therefore reject every processed claim, not just late
// ones, so it is intentionally only wired into the instant-add route.

import { isFinished, isLive } from "./format.js";

// One club's lock state for one gameweek. `team` is a normalized team name
// (see normalizeTeamName/domain.js, the same join key matches and players
// already share); `matches` is the mapped match list (mapApiFootball.js);
// `gameweek` is the matchday in question; `now` is injected (anything `new
// Date()` accepts, including a Date or epoch ms) so this stays pure and
// deterministic - it never reads the clock itself.
//
// Returns { locked, kickoff, reason }:
//   - No fixture for `team` in `gameweek` (a blank gameweek: the club has no
//     match that matchday, e.g. a postponed-and-not-yet-rescheduled slot)
//     is NOT locked - there is nothing to have banked or lost points from.
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
  const fixture = (matches ?? []).find(
    (match) => match.matchday === gameweek && (match.homeTeam === team || match.awayTeam === team),
  );
  if (!fixture) return { locked: false, kickoff: null, reason: "no fixture this gameweek" };

  const kickoff = fixture.utcDate ?? null;

  if (isLive(fixture.status)) return { locked: true, kickoff, reason: "live" };
  if (isFinished(fixture.status)) return { locked: true, kickoff, reason: "finished" };
  if (fixture.status === "POSTPONED" || fixture.status === "CANCELLED") {
    return { locked: false, kickoff, reason: "postponed or cancelled" };
  }

  const nowMs = toEpochMs(now);
  const kickoffMs = toEpochMs(kickoff);
  const started = Number.isFinite(nowMs) && Number.isFinite(kickoffMs) && kickoffMs <= nowMs;
  return started ? { locked: true, kickoff, reason: "kicked off" } : { locked: false, kickoff, reason: "not kicked off" };
}

function toEpochMs(value) {
  if (value == null) return NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return new Date(value).getTime();
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
