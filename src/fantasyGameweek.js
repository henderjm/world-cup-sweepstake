// Pure fantasy gameweek scoring/status/standings logic (Phase 4.3). No DOM, no
// fetch, no D1: the Worker's weekly scoring cron and its /matchup and
// /standings routes are thin shells around these functions, mirroring how
// fantasyScoring.js and fantasyLineups.js keep the same rules unit-tested
// outside the Worker.
//
// Which gameweek a fixture belongs to is NOT decided here: it comes from
// fantasyCalendar.js, where a gameweek is a window of wall-clock time and a
// fixture is placed by its actual kickoff rather than by the provider's
// matchday label. Read that module's header before changing anything below
// that filters or groups by gameweek.

import {
  assignGameweeks,
  buildGameweekCalendar,
  gameweekFixtures,
  gameweekForInstant,
  gameweekOf,
} from "./fantasyCalendar.js";
import { isFinished, isLive } from "./format.js";
import { TERMINAL_MATCH_STATUSES } from "./mapApiFootball.js";

// Sums per-MATCH player scores into the one-number-per-player map the roster
// rollup wants. Rows are [{ playerId, points }] and a player may legitimately
// appear more than once: in a double gameweek his club plays twice inside the
// same window, and both matches score into that gameweek. Building the map
// with `new Map(rows.map(...))` instead would keep only the last row and throw
// the other match away, which is exactly the silent-overwrite failure the
// window model makes reachable, so the accumulation lives here where it is
// tested rather than being re-improvised at each call site.
export function sumPlayerPoints(rows) {
  const totals = new Map();
  for (const row of rows ?? []) {
    if (row?.playerId == null) continue;
    totals.set(row.playerId, (totals.get(row.playerId) ?? 0) + (row.points ?? 0));
  }
  return totals;
}

// Rolls up one manager's resolved starting XI into a gameweek total. `lineup`
// is the { starters: [{ playerId, isCaptain }] } shape resolveEffectiveLineup
// and defaultLineup already produce. `playerPointsMap` is a Map<playerId,
// points> for one gameweek, ALREADY summed across every match that player
// featured in that gameweek (see sumPlayerPoints); a starter absent from it
// (their match has not been scored yet, they blanked, or their club had a
// blank gameweek and played no match at all) contributes 0, never throws. The
// captain's points are doubled outright (schema comment on
// fantasy_gameweek_scores: "captain doubled"), not topped up with a bonus.
export function rosterGameweekPoints(lineup, playerPointsMap) {
  const starters = lineup?.starters ?? [];
  const breakdown = starters.map((starter) => {
    const base = playerPointsMap?.get(starter.playerId) ?? 0;
    const isCaptain = Boolean(starter.isCaptain);
    return { playerId: starter.playerId, points: isCaptain ? base * 2 : base, isCaptain };
  });
  const points = breakdown.reduce((sum, entry) => sum + entry.points, 0);
  return { points, breakdown };
}

// One gameweek's state, derived from the mapped match list's own status
// vocabulary (see src/format.js): "scheduled" if none of this gameweek's
// matches have started yet (including an empty match list for that
// gameweek, e.g. it hasn't been loaded), "final" once every one of them is
// settled (TERMINAL_MATCH_STATUSES: FINISHED/AWARDED, or a CANCELLED/
// POSTPONED fixture that will never produce a score), otherwise "live" (at
// least one match under way or finished while another has not kicked off).
// A postponed match must count as settled here, or a gameweek containing
// one would report "live" forever even once every playable match is done.
//
// "This gameweek's matches" means every fixture the CALENDAR assigns to the
// window (see fantasyCalendar.js), so a fixture replayed inside this window
// keeps it non-final until it too is settled, and a fixture that has moved
// OUT of the window no longer holds it open.
export function gameweekStatus(matches, gameweek) {
  const relevant = gameweekFixtures(assignGameweeks(matches), gameweek);
  if (!relevant.length) return "scheduled";
  if (relevant.every((match) => TERMINAL_MATCH_STATUSES.has(match.status))) return "final";
  const started = relevant.some((match) => isFinished(match.status) || isLive(match.status));
  return started ? "live" : "scheduled";
}

// The gameweek that is still "in progress" from the season's point of view.
// Two signals, and the answer is whichever is FURTHER ON:
//
//   1. The smallest gameweek with at least one match not yet settled, or
//      (once every match is settled) one past the season's last gameweek, so
//      the final gameweek is treated as fully in the past rather than
//      perpetually "current" (standingsFromFixtures' callers filter to
//      gameweek < current, and a "current" that never advanced past 38 would
//      permanently exclude gameweek 38 from standings). A CANCELLED/POSTPONED
//      match counts as settled: it is never going to become FINISHED/AWARDED.
//      This is what advances the gameweek as soon as a round finishes, days
//      before the next round's window opens.
//
//   2. The gameweek whose calendar window contains `now`. This is a FLOOR, and
//      it is the whole reason the current gameweek can never move backwards:
//      wall-clock time only moves one way, so a rescheduled, reinstated or
//      newly-published fixture in an already-played window can shift signal 1
//      but can never drag the answer below where the calendar already is.
//
// `now` is injected rather than read here so the function stays pure and
// testable, the same discipline as playerLockState in fantasyLocks.js; it
// defaults to the clock only so an existing caller with no notion of "now"
// (and every match list that carries no dates at all) keeps working.
export function currentGameweekFromMatches(matches, now = Date.now()) {
  const calendar = buildGameweekCalendar(matches);
  const assigned = assignGameweeks(matches, calendar).filter((match) => Number.isInteger(gameweekOf(match)));
  if (!assigned.length) return 1;

  const unsettled = assigned.filter((match) => !TERMINAL_MATCH_STATUSES.has(match.status));
  const earliestUnsettled = unsettled.length
    ? Math.min(...unsettled.map(gameweekOf))
    : Math.max(...assigned.map(gameweekOf)) + 1;

  const windowGameweek = gameweekForInstant(calendar, now) ?? 1;
  return Math.max(earliestUnsettled, windowGameweek);
}

// Ranks `members` from `fixtures`, an array of already-decided { gameweek,
// homeUserId, awayUserId, homeScore, awayScore } rows the CALLER has already
// filtered down to completed gameweeks (this function has no notion of
// "current gameweek", so it stays pure and trivially testable). A fixture
// with either score missing is skipped entirely, not scored as a 0-0 draw. A
// member with no decided fixture at all (a bye week, or the season hasn't
// started) still appears with played: 0 rather than being dropped.
// recordPoints follows the standard win/draw/loss ranking convention
// (win = 3, draw = 1, loss = 0). Sorted descending by recordPoints, then
// pointsFor, then name, for stable ordering when two managers tie on both.
export function standingsFromFixtures(fixtures, members) {
  const rows = new Map(
    (members ?? []).map((member) => [
      member.userId,
      {
        userId: member.userId,
        name: member.name,
        // Carried straight through, never derived here: a bot manager's row
        // has to be labelled as one in the table it appears in, and only the
        // caller knows which members are bots. Absent for a caller with no
        // bots, which reads as false.
        isBot: Boolean(member.isBot),
        // Carried through for the same reason as isBot, and kept separate from
        // it: the Average opponent an odd league plays instead of a bye has to
        // be labelled in the table it appears in, and labelling it a bot would
        // claim a manager exists where none does (see src/fantasyAverage.js).
        isAverage: Boolean(member.isAverage),
        played: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        pointsFor: 0,
        pointsAgainst: 0,
      },
    ]),
  );

  for (const fixture of fixtures ?? []) {
    const { homeUserId, awayUserId, homeScore, awayScore } = fixture;
    if (homeScore == null || awayScore == null) continue;
    applyFixtureResult(rows.get(homeUserId), homeScore, awayScore);
    applyFixtureResult(rows.get(awayUserId), awayScore, homeScore);
  }

  return [...rows.values()]
    .map((row) => ({ ...row, recordPoints: row.wins * 3 + row.draws }))
    .sort((a, b) => b.recordPoints - a.recordPoints || b.pointsFor - a.pointsFor || a.name.localeCompare(b.name));
}

function applyFixtureResult(row, forScore, againstScore) {
  if (!row) return; // a fixture side that isn't in `members` is out of scope, not an error
  row.played += 1;
  row.pointsFor += forScore;
  row.pointsAgainst += againstScore;
  if (forScore > againstScore) row.wins += 1;
  else if (forScore < againstScore) row.losses += 1;
  else row.draws += 1;
}
