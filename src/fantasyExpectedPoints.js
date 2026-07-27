// Expected points (xP): what a player is worth in an average gameweek, in this
// app's own scoring units.
//
// The whole module is built on one rule: xP must be denominated in exactly the
// points fantasyScoring.js would actually award, or the number is a lie. A user
// who sees "xP 5.2" and then watches that player score 5 has been told the
// truth; one who sees a figure from some other scale has not. So every
// conversion below reuses SCORING rather than restating a coefficient, and the
// card handling deliberately mirrors scoreMatchForPlayers' "strongest outcome
// only, once per match" rule (see cardPoints).
//
// Pure: array/object in, number out. No fetch, no DOM, no D1. The bake script
// (build time), the Worker (in-season blend) and the browser all import this
// same file, the same cross-environment contract mapApiFootball.js follows.

import { SCORING } from "./fantasy.js";

export const GAMEWEEKS_PER_SEASON = 38;

// Season recency weights, most recent first. A player's form three years ago
// says less about next Saturday than last season did, but it is not noise
// either: three weighted seasons ride out a single injury-wrecked or
// freakishly hot campaign, which is exactly the failure mode of a one-season
// index (a striker who missed 30 games last year is not worthless).
export const SEASON_WEIGHTS = [3, 2, 1];

// Shrinkage prior for the in-season blend, in gameweeks. At gameweek 0 xP is
// purely historical; by gameweek 6 history and this season carry equal weight;
// by the run-in the current season dominates. Chosen so one explosive
// gameweek cannot crown a fringe player in September, which is the standard
// way a naive "points so far / weeks played" number embarrasses itself.
export const PRIOR_WEIGHT_GAMEWEEKS = 6;

// How a season aggregate becomes points. API-Football hands back season
// totals, not per-match rows, so a few of these are necessarily estimates
// rather than replays. Each one is called out where it is made; nothing here
// silently invents a quantity.

// Cards are the subtle one. fantasyScoring.js collapses a match to a single
// strongest outcome: a dismissal costs redCard and nothing else, a booking
// costs yellowCard, and a second-yellow dismissal costs ONE red, never a
// yellow plus a red. Season aggregates have to be un-collapsed the same way.
//
// API-Football reports `yellow`, `yellowred` (second-yellow dismissals) and
// `red` (straight reds) separately, and counts the first booking of a
// second-yellow dismissal inside `yellow` as well. So the matches that cost a
// red are (red + yellowred), and the matches that cost only a booking are the
// yellows left over once each dismissal's own first booking is removed.
export function cardPoints({ yellow = 0, yellowRed = 0, red = 0 } = {}) {
  const dismissals = num(red) + num(yellowRed);
  const bookingOnlyMatches = Math.max(0, num(yellow) - num(yellowRed));
  return dismissals * SCORING.redCard + bookingOnlyMatches * SCORING.yellowCard;
}

// Clean sheets are not in the player payload at all: API-Football gives
// `goals.conceded`, which is a total, not a count of shut-outs, and is only
// meaningfully populated for goalkeepers. So this is the one genuinely
// modelled term. A player earns a clean sheet whenever they appear for a side
// that concedes nothing, so over a season the expectation is simply their
// appearances times their club's clean-sheet rate. That is exact in
// expectation and wrong only in variance, which is the right trade for a
// number that is itself an average.
//
// FWD scores 0 for a clean sheet, so this stays correct for them without a
// special case.
export function cleanSheetPoints({ appearances = 0 }, position, cleanSheetRate = 0) {
  const rate = clamp01(num(cleanSheetRate));
  const value = SCORING.cleanSheet[position] ?? SCORING.cleanSheet.MID;
  return num(appearances) * rate * value;
}

// One season's aggregate line, scored exactly as the live engine would have
// scored the matches behind it. `line` is the normalized shape the bake
// produces (see normalizeSeasonLine), NOT a raw API-Football row.
export function seasonFantasyPoints(line, position, cleanSheetRate = 0) {
  if (!line) return 0;
  const pos = position ?? "MID";
  const appearances = num(line.appearances);
  const goalValue = SCORING.goal[pos] ?? SCORING.goal.MID;

  return (
    appearances * SCORING.appearance +
    num(line.goals) * goalValue +
    num(line.assists) * SCORING.assist +
    num(line.ownGoals) * SCORING.ownGoal +
    cleanSheetPoints(line, pos, cleanSheetRate) +
    cardPoints(line)
  );
}

// Per-gameweek rather than per-appearance, deliberately. A player who starts
// 19 of 38 games is worth half a starter to a fantasy manager, and dividing by
// appearances would flatter him into looking like a full one. Availability is
// part of the asset.
export function seasonExpectedPointsPerGameweek(line, position, cleanSheetRate = 0) {
  return seasonFantasyPoints(line, position, cleanSheetRate) / GAMEWEEKS_PER_SEASON;
}

// Weighted blend across however many seasons a player actually has, most
// recent first. Seasons the player did not feature in at all are skipped
// rather than counted as zero: a player who was in the Championship two years
// ago should not be punished for the absence, only for what he did when he
// did play. Returns null when there is no usable history at all, so the caller
// has to decide what to show rather than being handed a fabricated 0.
export function historicalExpectedPoints(seasonLines, position, cleanSheetRates = []) {
  const lines = seasonLines ?? [];
  let weighted = 0;
  let weightUsed = 0;
  let seasonsUsed = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || num(line.appearances) <= 0) continue;
    const weight = SEASON_WEIGHTS[i] ?? 1;
    weighted += weight * seasonExpectedPointsPerGameweek(line, position, cleanSheetRates[i] ?? 0);
    weightUsed += weight;
    seasonsUsed += 1;
  }

  if (!weightUsed) return null;
  return { xp: weighted / weightUsed, seasonsUsed };
}

// The in-season blend: shrink this season's actual scoring toward the
// historical prior, with the prior losing influence as real evidence
// accumulates. At gameweeksPlayed 0 this returns the prior untouched, so the
// same function serves draft night and matchday 30.
export function blendWithCurrentSeason(historicalXp, currentSeasonPoints, gameweeksPlayed) {
  const played = Math.max(0, num(gameweeksPlayed));
  const prior = historicalXp == null ? null : num(historicalXp);
  if (!played) return prior;
  const observed = num(currentSeasonPoints) / played;
  if (prior == null) return observed;
  return (PRIOR_WEIGHT_GAMEWEEKS * prior + played * observed) / (PRIOR_WEIGHT_GAMEWEEKS + played);
}

// The baseline for a player with no Premier League history: 115 of the current
// pool, plus every player at a promoted club. Rather than invent a constant,
// this is the median xP of the players who DO have history in the same
// position and tier, so it moves with the real distribution and cannot drift
// away from it. Median, not mean, because the cohorts are small and a single
// superstar would drag a mean upward.
//
// Callers must mark the result as an estimate (see expectedPointsFor's
// `basis`); a guess presented as a measurement is the one outcome worth
// refusing outright.
export function baselineFromCohort(cohort, position, tier) {
  const peers = (cohort ?? [])
    .filter((entry) => entry && entry.position === position && entry.tier === tier && entry.xp != null)
    .map((entry) => num(entry.xp))
    .sort((a, b) => a - b);
  if (!peers.length) return null;
  const mid = Math.floor(peers.length / 2);
  return peers.length % 2 ? peers[mid] : (peers[mid - 1] + peers[mid]) / 2;
}

// The single entry point the bake and the Worker both call. `basis` is the
// honesty channel: "history" is measured, "blended" mixes measurement with
// this season, "estimate" is a cohort baseline, and null means we genuinely
// do not know and the UI should say so rather than print a number.
export function expectedPointsFor({
  seasonLines = [],
  position = "MID",
  cleanSheetRates = [],
  currentSeasonPoints = null,
  gameweeksPlayed = 0,
  cohort = null,
  tier = "unknown",
} = {}) {
  const history = historicalExpectedPoints(seasonLines, position, cleanSheetRates);

  if (history) {
    const blended = gameweeksPlayed > 0 ? blendWithCurrentSeason(history.xp, currentSeasonPoints, gameweeksPlayed) : history.xp;
    return {
      xp: round1(blended),
      basis: gameweeksPlayed > 0 ? "blended" : "history",
      seasonsUsed: history.seasonsUsed,
    };
  }

  // No history. This season's own record still beats a cohort guess once there
  // is any of it, which is how a promoted club's breakout gets recognised
  // instead of being pinned to a baseline all year.
  if (gameweeksPlayed > 0) {
    return { xp: round1(num(currentSeasonPoints) / gameweeksPlayed), basis: "blended", seasonsUsed: 0 };
  }

  const baseline = cohort ? baselineFromCohort(cohort, position, tier) : null;
  if (baseline == null) return { xp: null, basis: null, seasonsUsed: 0 };
  return { xp: round1(baseline), basis: "estimate", seasonsUsed: 0 };
}

// Normalizes one raw API-Football statistics row into the shape the functions
// above expect. Kept here, beside the consumers, so the field-name quirks live
// in one place: API-Football spells it "appearences", reports second-yellow
// dismissals under "yellowred", and nests everything differently per block.
export function normalizeSeasonLine(row) {
  if (!row) return null;
  return {
    appearances: num(row.games?.appearences ?? row.games?.appearances),
    lineups: num(row.games?.lineups),
    minutes: num(row.games?.minutes),
    goals: num(row.goals?.total),
    assists: num(row.goals?.assists),
    conceded: num(row.goals?.conceded),
    yellow: num(row.cards?.yellow),
    yellowRed: num(row.cards?.yellowred),
    red: num(row.cards?.red),
    // Own goals are absent from API-Football's player statistics block. They
    // are rare enough (a handful league-wide per season) that omitting them
    // moves nobody's xP meaningfully, and inventing them would be worse.
    ownGoals: 0,
  };
}

// Clean-sheet rate per club for one season, from that season's finished
// fixtures: the share of a club's matches in which it conceded nothing.
// Keyed by the same canonical club name the rest of the app joins on, so
// callers must pass names already through normalizeTeamName.
export function clubCleanSheetRates(matches) {
  const played = new Map();
  const clean = new Map();
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

  for (const match of matches ?? []) {
    const home = match?.homeTeam;
    const away = match?.awayTeam;
    const homeGoals = match?.score?.home ?? match?.homeScore;
    const awayGoals = match?.score?.away ?? match?.awayScore;
    if (!home || !away) continue;
    if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) continue;
    bump(played, home);
    bump(played, away);
    if (awayGoals === 0) bump(clean, home);
    if (homeGoals === 0) bump(clean, away);
  }

  const rates = new Map();
  for (const [team, count] of played) {
    rates.set(team, count ? (clean.get(team) ?? 0) / count : 0);
  }
  return rates;
}

// Weighted clean-sheet rate for one player-season when they turned out for
// more than one club (a mid-season transfer): the appearances-weighted
// average across every club they actually played for that season, rather
// than picking one arbitrarily or defaulting to their current club (which
// would silently misattribute a season played elsewhere entirely).
// `clubAppearances` is a Map<clubName, appearances> and `cleanSheetRates` is
// that same season's Map<clubName, rate> from clubCleanSheetRates; both keyed
// by the SAME normalized name (callers must run club names through
// normalizeTeamName before building either map, exactly like
// clubCleanSheetRates itself requires). A club missing from `cleanSheetRates`
// (no fixture data for it that season) contributes a rate of 0 for its
// appearances rather than being dropped, since dropping it would shrink the
// denominator and silently inflate the rest.
export function weightedCleanSheetRate(clubAppearances, cleanSheetRates) {
  if (!clubAppearances || !clubAppearances.size) return 0;
  let weighted = 0;
  let total = 0;
  for (const [club, appearances] of clubAppearances) {
    const apps = num(appearances);
    weighted += apps * num(cleanSheetRates?.get(club) ?? 0);
    total += apps;
  }
  return total ? weighted / total : 0;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function round1(value) {
  return Math.round(value * 10) / 10;
}
