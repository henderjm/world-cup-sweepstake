// Pure fantasy gameweek scoring/status/standings logic (Phase 4.3). No DOM, no
// fetch, no D1: the Worker's weekly scoring cron and its /matchup and
// /standings routes are thin shells around these functions, mirroring how
// fantasyScoring.js and fantasyLineups.js keep the same rules unit-tested
// outside the Worker.

import { isFinished, isLive } from "./format.js";
import { TERMINAL_MATCH_STATUSES } from "./mapApiFootball.js";

// Rolls up one manager's resolved starting XI into a gameweek total. `lineup`
// is the { starters: [{ playerId, isCaptain }] } shape resolveEffectiveLineup
// and defaultLineup already produce. `playerPointsMap` is a Map<playerId,
// points> for one gameweek; a starter absent from it (their match has not
// been scored yet, or they did not feature at all) contributes 0, never
// throws. The captain's points are doubled outright (schema comment on
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
export function gameweekStatus(matches, gameweek) {
  const relevant = (matches ?? []).filter((match) => match.matchday === gameweek);
  if (!relevant.length) return "scheduled";
  if (relevant.every((match) => TERMINAL_MATCH_STATUSES.has(match.status))) return "final";
  const started = relevant.some((match) => isFinished(match.status) || isLive(match.status));
  return started ? "live" : "scheduled";
}

// The gameweek that is still "in progress" from the season's point of view:
// the smallest matchday with at least one match not yet settled, or (once
// every match is settled) one past the season's last matchday, so the final
// gameweek itself is treated as fully in the past rather than perpetually
// "current" (standingsFromFixtures' callers filter to gameweek < current,
// and a "current" that never advances past 38 would permanently exclude
// gameweek 38 from standings). A CANCELLED/POSTPONED match counts as
// settled: it is never going to become FINISHED/AWARDED, so treating it as
// still-pending would freeze the whole season at that gameweek forever.
export function currentGameweekFromMatches(matches) {
  const matchdays = (matches ?? [])
    .filter((match) => Number.isInteger(match.matchday))
    .map((match) => ({ matchday: match.matchday, settled: TERMINAL_MATCH_STATUSES.has(match.status) }));
  if (!matchdays.length) return 1;
  const unsettled = matchdays.filter((entry) => !entry.settled);
  if (unsettled.length) return Math.min(...unsettled.map((entry) => entry.matchday));
  return Math.max(...matchdays.map((entry) => entry.matchday)) + 1;
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
