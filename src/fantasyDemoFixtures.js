// Fixture-aware scoring support for the try-a-draft demo: joins a player's
// club to its real matchday fixture from data/PL/live.json, and derives a
// per-club strength signal used to bias a fixture's difficulty. No DOM, no
// fetch: app.js fetches the static live feed once and hands the raw matches/
// standings in here, mirroring how fantasyDemo.js itself stays pure.
//
// Why this is its own module rather than folding into fantasyDemo.js: the
// fixture join and the club-strength derivation are each independently
// testable units where a wrong join silently zeroes every score for a
// mis-spelled club, so they get their own focused module and test file
// rather than growing fantasyDemo.js's already-long season section further.

import { mapStandings, normalizeTeamName } from "./domain.js";

// -- Fixture join ---------------------------------------------------------------

// One lookup per gameweek: Map<gameweek, Map<team, { opponent, isHome }>>.
// Built once per season rather than re-scanning `matches` for every player on
// every gameweek (556 players * 38 gameweeks would otherwise be 21,128 linear
// scans of a 380-row array). A club absent from a gameweek's inner map has a
// blank gameweek that matchday - the caller's job to treat as "no fixture",
// not this module's (a Map.get returning undefined already says that).
export function buildFixtureIndex(matches) {
  const index = new Map();
  for (const match of matches ?? []) {
    if (!Number.isInteger(match.matchday)) continue;
    const home = normalizeTeamName(match.homeTeam);
    const away = normalizeTeamName(match.awayTeam);
    if (!index.has(match.matchday)) index.set(match.matchday, new Map());
    const gwIndex = index.get(match.matchday);
    gwIndex.set(home, { opponent: away, isHome: true });
    gwIndex.set(away, { opponent: home, isHome: false });
  }
  return index;
}

// A player's own fixture for one gameweek, or null for a blank gameweek (their
// club has no fixture that matchday - a real fantasy lesson, not an error).
// `team` is run through normalizeTeamName so a pool entry using a shorter
// provider spelling (see the TEAM_ALIASES comment in domain.js) still joins
// against the canonical fixture-list key.
export function clubFixture(fixtureIndex, team, gameweek) {
  return fixtureIndex?.get(gameweek)?.get(normalizeTeamName(team)) ?? null;
}

// -- Club strength ----------------------------------------------------------------
//
// Opponent difficulty needs a strength signal per club. Two sources, tried in
// order, both DERIVED rather than a hand-typed table:
//   1. The real table, once it has actually played games (mapStandings' own
//      `played` count) - table position is the ground truth once it exists.
//   2. Before a ball is kicked (every `played` is 0, which is exactly the
//      2026/27 preseason snapshot this demo ships against), fall back to each
//      club's average prior-season player tier in the draft pool (see
//      fantasyPlayerTier.js/DEMO_TIER_MEAN) as a proxy for squad strength -
//      still derived from real prior-season minutes data, never invented.
// Either way the result is a Map<team, strength> normalized to (0, 1], where 1
// is the toughest club in the pool, so fixtureDifficultyMultiplier never needs
// to know which source produced it.
function rankToStrength(rank, total) {
  return (total - rank + 1) / total; // rank 1 (strongest) -> 1, rank N -> 1/N
}

function strengthFromRankedTeams(orderedTeams) {
  const total = orderedTeams.length;
  const strength = new Map();
  orderedTeams.forEach((team, index) => strength.set(team, rankToStrength(index + 1, total)));
  return strength;
}

function strengthFromStandings(standingsMap) {
  const rows = [...(standingsMap?.values() ?? [])];
  if (!rows.length || !rows.some((row) => (row.played ?? 0) > 0)) return null;
  const ordered = [...rows].sort((a, b) => (a.position ?? 999) - (b.position ?? 999)).map((row) => row.team);
  return strengthFromRankedTeams(ordered);
}

// How many players make up a club's strength: its best XI, not its whole
// listed squad. Averaging the full squad measures continuity, not quality, and
// gets the answer badly wrong: a club with academy players on the list is
// dragged down, while a promoted club whose players all have no Premier League
// record sits at a middling default and beats them. Against the real July 2026
// pool that ranked Man United the toughest fixture in the league and Leeds
// third, which reads as broken to anyone who follows the league.
const STRENGTH_SQUAD_DEPTH = 11;

// Strength from the squad's best XI by expected points. xP is the right
// signal because it is continuous and denominated in actual scoring, so it
// separates twenty clubs cleanly.
//
// Player tier deliberately is NOT used as a fallback signal here. It has only
// four levels, and every established club has at least eleven players in the
// top one, so a tier-based best XI saturates and ties Arsenal with Bournemouth.
// A ranking that cannot tell those apart is worse than no ranking, because it
// still presents itself as knowledge.
function strengthFromExpectedPoints(players) {
  const byTeam = new Map();
  for (const player of players ?? []) {
    if (!player?.team || player.xp == null) continue;
    const value = Number(player.xp);
    if (!Number.isFinite(value)) continue;
    const team = normalizeTeamName(player.team);
    if (!byTeam.has(team)) byTeam.set(team, []);
    byTeam.get(team).push(value);
  }
  if (!byTeam.size) return null;

  const totals = [...byTeam.entries()].map(([team, values]) => {
    const best = values.sort((a, b) => b - a).slice(0, STRENGTH_SQUAD_DEPTH);
    return [team, best.reduce((sum, value) => sum + value, 0)];
  });
  totals.sort((a, b) => b[1] - a[1]);

  // Tie-aware ranking. Converting totals straight to positions would hand two
  // genuinely equal squads different strengths purely from sort order, so the
  // model would claim a difference it cannot support. Equal totals share a
  // rank, and the next distinct total resumes at its positional rank so the
  // spread across the league is unchanged.
  const strength = new Map();
  let rank = 0;
  let previousTotal = null;
  totals.forEach(([team, total], index) => {
    if (previousTotal === null || total !== previousTotal) {
      rank = index + 1;
      previousTotal = total;
    }
    strength.set(team, rankToStrength(rank, totals.length));
  });
  return strength;
}

// Every club equally strong. Used when nothing trustworthy is available, so
// fixture difficulty collapses to home advantage alone rather than to an
// invented pecking order. Consistent with how xP itself refuses to print a
// number it cannot stand behind: a confidently wrong difficulty model is worse
// than an openly neutral one, because a user checks it against their own
// knowledge of the league and stops believing the rest of the app.
export const NEUTRAL_CLUB_STRENGTH = 0.5;

function neutralStrength(players) {
  const strength = new Map();
  for (const player of players ?? []) {
    if (!player?.team) continue;
    strength.set(normalizeTeamName(player.team), NEUTRAL_CLUB_STRENGTH);
  }
  return strength;
}

// `standingsMap` is the Map mapStandings/standingsMapFromRawPayload produce;
// `players` is the draft pool (data/PL/players.json's players array).
//
// Preference order is strongest evidence first: the real table once matches
// have been played, then the squads' own expected points, then neutral.
export function deriveClubStrength({ standingsMap, players } = {}) {
  return strengthFromStandings(standingsMap) ?? strengthFromExpectedPoints(players) ?? neutralStrength(players);
}

// Builds the standings Map deriveClubStrength expects straight from the raw
// data/PL/live.json payload, reusing domain.js's own mapStandings (the exact
// TOTAL-row filter and team-name join data.js's buildModel relies on) rather
// than re-deriving it. Zones are irrelevant to a strength signal, so this
// skips buildModel's zone/competition wiring entirely.
export function standingsMapFromRawPayload(raw) {
  return mapStandings({ standings: raw?.standings ?? [] });
}

// -- Fixture difficulty -----------------------------------------------------------

export const HOME_ADVANTAGE = 0.08;
export const AWAY_DISADVANTAGE = -0.05;
// How much a fixture can swing a player's score around the tier/position
// baseline from opponent strength alone: the toughest possible opponent
// (strength 1) knocks it down by this much, the weakest (strength close to 0)
// lifts it by close to the same amount, linearly in between around a neutral
// 0.5 opponent.
export const OPPONENT_STRENGTH_SWING = 0.5;
const MIN_MULTIPLIER = 0.5;
const MAX_MULTIPLIER = 1.6;

// `opponentStrength` is nullable (no fixture data was available at all, e.g.
// the static feed failed to fetch): a neutral 1x multiplier rather than
// guessing, so a data-loading failure degrades to the OLD flat scoring
// instead of silently zeroing or inflating every score.
export function fixtureDifficultyMultiplier(opponentStrength, isHome) {
  if (opponentStrength == null) return 1;
  const homeAway = isHome ? HOME_ADVANTAGE : AWAY_DISADVANTAGE;
  const opponentSwing = (0.5 - opponentStrength) * OPPONENT_STRENGTH_SWING;
  const multiplier = 1 + homeAway + opponentSwing;
  return Math.min(MAX_MULTIPLIER, Math.max(MIN_MULTIPLIER, multiplier));
}
