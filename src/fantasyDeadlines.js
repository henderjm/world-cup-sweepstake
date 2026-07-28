// Pure squad-deadline and season-phase logic. No DOM, no fetch, no D1: the
// Worker's lineup and free-agent routes and the browser's countdown all derive
// the same instants from the same feed, the same discipline as
// fantasyCalendar.js and fantasyWaivers.js.
//
// THE RULE THIS MODULE OWNS: a squad is locked for a gameweek from that
// gameweek's FIRST kickoff minus SQUAD_LOCK_LEAD_MS. One league-wide deadline,
// the FPL model, which is what a manager means by "the gameweek deadline".
// Before it, lineups, captaincy and transfers are all open; after it, the
// squad is frozen for that gameweek.
//
// This REPLACES the per-player rule as the thing that decides whether a
// manager may act. It does not delete it: playerLockState (fantasyLocks.js) is
// kept as a BACKSTOP, and playerSquadLock below is the composition. A club
// that has actually kicked off is locked regardless of what any deadline
// arithmetic says, which costs one function call and covers every way the
// deadline could be wrong: a feed with no kickoff for the window, a fixture
// brought forward after the deadline was computed, or a gameweek whose
// calendar window is empty. The deadline is the rule; the kickoff is the
// floor under it.
//
// -- RECONCILING THE TWO DEADLINES -------------------------------------------
//
// This app now has two data-derived instants per gameweek, and they answer
// different questions. Keeping them separate is deliberate; what would be
// worse than either alone is leaving a reader to discover the second one by
// accident, so gameweekTimetable below returns BOTH and is the only place
// either should be read from when both matter.
//
//   squadDeadline  = firstKickoff - SQUAD_LOCK_LEAD_MS   (this module)
//     "May I change what my squad does in THIS gameweek?"
//     Governs lineups, captaincy and instant free-agent adds, because all
//     three change the points this gameweek is about to score.
//
//   quietFrom      = lastKickoff - WAIVER_QUIET_PERIOD_MS  (fantasyWaivers.js)
//   earliestRunAt  = lastKickoff + WAIVER_SETTLE_BUFFER_MS
//     "Which RUN does a queued claim land in, and when may that run execute?"
//     Governs waiver claims, which resolve after this gameweek has settled and
//     therefore change the NEXT gameweek's squad, not this one.
//
// A queued waiver claim is deliberately NOT gated by the squad deadline, for
// exactly the reason fantasyLocks.js already gives for not gating it on
// kickoff: the claim does not take effect until every match in this gameweek
// is terminal, so it cannot bank or dodge a result. Gating it would reject
// every claim submitted on a matchday rather than just the retroactive ones.
//
// The two are provably ORDERED, which is what makes them safe to hold at once:
// firstKickoff <= lastKickoff by construction, and the lead (2h) is greater
// than the quiet period (1h), so
//
//   squadDeadline < quietFrom < lastKickoff < earliestRunAt
//
// always, by at least an hour, for every gameweek that has any fixture at all.
// A manager therefore never sees the confusing pair "claims are closed but you
// may still change your team": the squad closes first, and the claim window
// closes later. gameweekTimetable asserts this ordering by returning them
// together, and test/fantasy-deadlines.test.js checks it against the real
// 380-fixture schedule rather than trusting the arithmetic above.

import {
  firstKickoffInGameweek,
  lastKickoffInGameweek,
  seasonFirstKickoff,
  toEpochMs,
} from "./fantasyCalendar.js";
import { playerLockState } from "./fantasyLocks.js";
import { waiverRunWindow } from "./fantasyWaivers.js";

// Two hours before the gameweek's first kickoff. The same lead FPL uses, which
// is the number managers coming from that game already have in their heads.
export const SQUAD_LOCK_LEAD_MS = 2 * 60 * 60 * 1000;

// The instant a gameweek's squads freeze, or null when the window carries no
// parseable kickoff (a fully blank window, a feed without dates, or no feed at
// all). Null means "no deadline derivable", which every caller here treats as
// NOT locked: failing open matches what currentFantasyMatches, waiverRunWindow
// and the free-agent path already do, since freezing every manager's team on a
// feed blip is worse than the rare window it leaves open. The kickoff backstop
// still applies underneath.
export function squadDeadline(matches, gameweek) {
  const firstKickoff = firstKickoffInGameweek(matches, gameweek);
  return firstKickoff == null ? null : firstKickoff - SQUAD_LOCK_LEAD_MS;
}

// The league-wide lock state for one gameweek. `now` is injected so this stays
// pure and deterministic, the same contract as playerLockState.
//
// `msRemaining` is what the UI counts down and is null whenever there is no
// deadline to count down to; it is clamped at zero rather than going negative,
// so a caller rendering it can never print a negative countdown.
export function squadLockState({ matches, gameweek, now } = {}) {
  const deadline = squadDeadline(matches, gameweek);
  const at = toEpochMs(now);
  if (deadline == null || !Number.isFinite(at)) {
    return { gameweek, deadline, locked: false, msRemaining: null };
  }
  const locked = at >= deadline;
  return { gameweek, deadline, locked, msRemaining: locked ? 0 : deadline - at };
}

// Both of this gameweek's timetables in one object, so no caller has to know
// that the second one exists to render an honest answer. See the reconciliation
// note at the top of this file for why they are two instants and not one.
export function gameweekTimetable({ matches, gameweek, now } = {}) {
  return {
    gameweek,
    squad: squadLockState({ matches, gameweek, now }),
    waivers: waiverRunWindow({ matches, gameweek, now }),
    firstKickoff: firstKickoffInGameweek(matches, gameweek),
    lastKickoff: lastKickoffInGameweek(matches, gameweek),
  };
}

// -- Season phase -------------------------------------------------------------
//
// Pre-season is "the season's first kickoff has not happened yet", derived
// from the schedule and never a hardcoded date. It is deliberately NOT the
// same question as "is gameweek 1's squad deadline still ahead": for the two
// hours between that deadline and the opening kickoff, the season still has
// not started AND the squad is already locked, and both of those are true
// things a manager should be told. Collapsing them would make one of the two
// lie for two hours.
//
// `seasonStart` is the instant itself so a caller can name the date rather
// than say "soon".
export function seasonPhase({ matches, now } = {}) {
  const seasonStart = seasonFirstKickoff(matches);
  const at = toEpochMs(now);
  if (seasonStart == null || !Number.isFinite(at)) {
    return { preseason: false, seasonStart, msUntilSeason: null };
  }
  const preseason = at < seasonStart;
  return { preseason, seasonStart, msUntilSeason: preseason ? seasonStart - at : null };
}

// -- The composed rule every acquisition path enforces -------------------------
//
// Deadline first, kickoff as the backstop underneath it. `reason` names which
// one fired, so a route can tell a manager WHY rather than just "no":
//   "deadline"  the league-wide squad deadline has passed.
//   "live" | "finished" | "kicked off"  the club's own match has started
//                                        despite the deadline saying otherwise.
// An unlocked result carries playerLockState's own reason ("not kicked off",
// "no fixture this gameweek", "postponed or cancelled") unchanged.
export function playerSquadLock({ team, matches, gameweek, now } = {}) {
  const squad = squadLockState({ matches, gameweek, now });
  if (squad.locked) return { locked: true, reason: "deadline", deadline: squad.deadline };

  const kickoff = playerLockState({ team, matches, gameweek, now });
  return { locked: kickoff.locked, reason: kickoff.reason, deadline: squad.deadline };
}

// The Set of player ids locked for `gameweek`, the composed-rule counterpart of
// lockedPlayerIds (fantasyLocks.js). Once the deadline has passed this is every
// player with an id, since the lock is league-wide; before it, it is whichever
// clubs the backstop catches. The Worker route and the Waivers panel share this
// one derivation rather than each re-walking the rule.
export function lockedSquadPlayerIds(players, matches, gameweek, now) {
  const locked = new Set();
  for (const player of players ?? []) {
    if (player?.id == null) continue;
    if (playerSquadLock({ team: player.team, matches, gameweek, now }).locked) locked.add(player.id);
  }
  return locked;
}
