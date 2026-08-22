// The league table with in-play results applied.
//
// The bug this fixes: the table did not move while matches were being played.
// It was not stale — there was no live table at all. `buildLeagueTables` takes
// the provider's standings verbatim for played/won/drawn/lost/points/GD (only
// `form` comes from match data), and providers recompute standings at FULL TIME,
// not per goal. `buildTeamPerformance` reinforced it by returning early for live
// matches (src/domain.js), recording a summary label and no points. So a table
// watched through a 3pm round was correct and completely still.
//
// This applies live matches on top, which is the FotMob-style "live table"
// managers actually watch on a Saturday: where would my club be right now.
//
// ONLY live matches are applied, never finished ones. A match in progress cannot
// be in the provider's standings yet, whereas a match that has just ended may or
// may not have been processed, and there is no way to tell from the payload which.
// Applying those would double-count for however long the provider took. The
// existing few-minute lag after full time is the honest alternative and it
// self-corrects.
//
// The guard below makes that safe even if a provider disagrees: if its `played`
// count for a club already exceeds the finished matches we can see, it is ahead
// of us and counting something we think is in progress, so that fixture is left
// alone rather than added twice.

import { isFinished, isLive } from "./format.js";
import { normalizeTeamName } from "./domain.js";
import { zoneFor } from "./competitions.js";

function hasScore(score) {
  return Number.isFinite(score?.home) && Number.isFinite(score?.away);
}

// How many matches each club has actually finished, per the feed. This is what
// the provider's `playedGames` is checked against.
function finishedCounts(matches) {
  const counts = new Map();
  const bump = (team) => {
    const key = normalizeTeamName(team);
    if (!key) return;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (const match of matches ?? []) {
    if (!isFinished(match.status) || !hasScore(match.score)) continue;
    bump(match.homeTeam);
    bump(match.awayTeam);
  }
  return counts;
}

// Points for a result, from the scoring side's perspective.
function outcome(scored, conceded) {
  if (scored > conceded) return { points: 3, won: 1, drawn: 0, lost: 0 };
  if (scored === conceded) return { points: 1, won: 0, drawn: 1, lost: 0 };
  return { points: 0, won: 0, drawn: 0, lost: 1 };
}

// Premier League order: points, then goal difference, then goals scored. Falls
// back to the club name so the sort is total and therefore stable across
// re-renders — two clubs level on all three would otherwise swap places on every
// poll, which reads as the table flickering.
function compareRows(a, b) {
  if (b.points !== a.points) return b.points - a.points;
  if (b.goalDifference !== a.goalDifference) return b.goalDifference - a.goalDifference;
  if ((b.goalsFor ?? 0) !== (a.goalsFor ?? 0)) return (b.goalsFor ?? 0) - (a.goalsFor ?? 0);
  return String(a.team).localeCompare(String(b.team));
}

// Returns { rows, liveTeams, applied }. `rows` is re-sorted with positions and
// zones recomputed; `liveTeams` is the set of clubs whose row moved, so the view
// can mark them; `applied` is how many fixtures were folded in.
//
// A no-op returns the ORIGINAL rows array by reference, so a caller can cheaply
// tell nothing happened and the table renders exactly as before.
export function applyLiveResults({ rows, matches, zones = [] } = {}) {
  if (!rows?.length) return { rows: rows ?? [], liveTeams: new Set(), applied: 0 };

  const finished = finishedCounts(matches);
  const byTeam = new Map(rows.map((row) => [row.team, { ...row }]));
  const liveTeams = new Set();
  let applied = 0;

  for (const match of matches ?? []) {
    if (!isLive(match.status) || !hasScore(match.score)) continue;
    const home = byTeam.get(normalizeTeamName(match.homeTeam));
    const away = byTeam.get(normalizeTeamName(match.awayTeam));
    // A club absent from the table (a cup guest, a name we could not join) is
    // skipped rather than invented: half a fixture applied would be worse than
    // none of it.
    if (!home || !away) continue;

    // The provider is ahead of us on either club: it has already counted a match
    // we believe is still in progress. Leave this fixture alone.
    const homeAhead = (home.played ?? 0) > (finished.get(home.team) ?? 0);
    const awayAhead = (away.played ?? 0) > (finished.get(away.team) ?? 0);
    if (homeAhead || awayAhead) continue;

    const h = outcome(match.score.home, match.score.away);
    const a = outcome(match.score.away, match.score.home);
    const diff = match.score.home - match.score.away;

    home.played += 1;
    home.points += h.points;
    home.won += h.won;
    home.drawn += h.drawn;
    home.lost += h.lost;
    home.goalDifference += diff;
    home.goalsFor = (home.goalsFor ?? 0) + match.score.home;

    away.played += 1;
    away.points += a.points;
    away.won += a.won;
    away.drawn += a.drawn;
    away.lost += a.lost;
    away.goalDifference -= diff;
    away.goalsFor = (away.goalsFor ?? 0) + match.score.away;

    liveTeams.add(home.team);
    liveTeams.add(away.team);
    applied += 1;
  }

  if (!applied) return { rows, liveTeams, applied: 0 };

  const sorted = [...byTeam.values()].sort(compareRows).map((row, index) => ({
    ...row,
    position: index + 1,
    zone: zoneFor(index + 1, zones),
    live: liveTeams.has(row.team),
  }));

  return { rows: sorted, liveTeams, applied };
}

// Applies the above to every table in a competition, leaving the shape
// buildLeagueTables produced untouched. `live` on the result says whether
// anything was folded in, so the view can label the table rather than silently
// showing figures that disagree with the provider's own.
export function withLiveTable({ tables, matches, zones = [] } = {}) {
  let anyApplied = 0;
  const next = (tables ?? []).map((table) => {
    const { rows, applied } = applyLiveResults({ rows: table.rows, matches, zones });
    anyApplied += applied;
    return applied ? { ...table, rows, live: true } : table;
  });
  return { tables: anyApplied ? next : tables ?? [], live: anyApplied > 0 };
}
