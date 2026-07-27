import test from "node:test";
import assert from "node:assert/strict";

import {
  GAMEWEEKS_PER_SEASON,
  PRIOR_WEIGHT_GAMEWEEKS,
  baselineFromCohort,
  blendWithCurrentSeason,
  cardPoints,
  cleanSheetPoints,
  clubCleanSheetRates,
  expectedPointsFor,
  historicalExpectedPoints,
  normalizeSeasonLine,
  seasonExpectedPointsPerGameweek,
  seasonFantasyPoints,
  weightedCleanSheetRate,
} from "../src/fantasyExpectedPoints.js";
import { SCORING } from "../src/fantasy.js";

const line = (over = {}) => ({
  appearances: 0,
  lineups: 0,
  minutes: 0,
  goals: 0,
  assists: 0,
  yellow: 0,
  yellowRed: 0,
  red: 0,
  ownGoals: 0,
  ...over,
});

// -- cardPoints: must mirror scoreMatchForPlayers' one-per-match rule ---------

test("cardPoints charges a booking once per yellow", () => {
  assert.equal(cardPoints({ yellow: 4 }), 4 * SCORING.yellowCard);
});

test("cardPoints charges a straight red as a single red, never a red plus a booking", () => {
  assert.equal(cardPoints({ red: 1 }), SCORING.redCard);
});

test("cardPoints charges a second-yellow dismissal as exactly one red", () => {
  // The live engine collapses first yellow + second yellow into ONE red. The
  // aggregate carries that first booking inside `yellow`, so it must be netted
  // off rather than charged again.
  assert.equal(cardPoints({ yellow: 1, yellowRed: 1 }), SCORING.redCard);
});

test("cardPoints keeps unrelated bookings when a dismissal also happened", () => {
  // 5 yellows across the season, one of which was the first half of a
  // second-yellow dismissal: 4 booking-only matches plus one red.
  assert.equal(cardPoints({ yellow: 5, yellowRed: 1 }), 4 * SCORING.yellowCard + SCORING.redCard);
});

test("cardPoints never returns a positive score from odd data", () => {
  assert.ok(cardPoints({ yellow: 0, yellowRed: 3 }) <= 0);
});

// -- clean sheets ------------------------------------------------------------

test("cleanSheetPoints is appearances times club rate times the positional value", () => {
  assert.equal(cleanSheetPoints({ appearances: 20 }, "DEF", 0.5), 20 * 0.5 * SCORING.cleanSheet.DEF);
});

test("cleanSheetPoints gives a forward nothing, since FWD clean sheets score zero", () => {
  assert.equal(cleanSheetPoints({ appearances: 38 }, "FWD", 1), 0);
});

test("cleanSheetPoints clamps a nonsense rate rather than inflating a season", () => {
  assert.equal(cleanSheetPoints({ appearances: 10 }, "GK", 4), 10 * 1 * SCORING.cleanSheet.GK);
});

// -- seasonFantasyPoints: hand-computed against the real SCORING table -------

test("seasonFantasyPoints totals an elite forward's season exactly", () => {
  // 38 apps, 25 goals, 10 assists, 5 bookings, 40% club clean sheets.
  // 38*2 + 25*4 + 10*3 + 0 (FWD clean sheets) - 5 = 201
  const points = seasonFantasyPoints(
    line({ appearances: 38, goals: 25, assists: 10, yellow: 5 }),
    "FWD",
    0.4,
  );
  assert.equal(points, 201);
});

test("seasonFantasyPoints totals an elite defender's season exactly", () => {
  // 38*2 + 3*6 + 5*3 + 38*0.45*4 - 6 = 76 + 18 + 15 + 68.4 - 6 = 171.4
  const points = seasonFantasyPoints(
    line({ appearances: 38, goals: 3, assists: 5, yellow: 6 }),
    "DEF",
    0.45,
  );
  assert.equal(Math.round(points * 10) / 10, 171.4);
});

test("seasonFantasyPoints scores a goal by the scorer's own position value", () => {
  const asDef = seasonFantasyPoints(line({ appearances: 1, goals: 1 }), "DEF", 0);
  const asFwd = seasonFantasyPoints(line({ appearances: 1, goals: 1 }), "FWD", 0);
  assert.equal(asDef - asFwd, SCORING.goal.DEF - SCORING.goal.FWD);
});

test("seasonExpectedPointsPerGameweek divides by the season, not by appearances", () => {
  // Availability is part of the asset: a half-season starter is worth half.
  const half = line({ appearances: 19, goals: 10 });
  const full = line({ appearances: 38, goals: 20 });
  const halfXp = seasonExpectedPointsPerGameweek(half, "FWD", 0);
  const fullXp = seasonExpectedPointsPerGameweek(full, "FWD", 0);
  assert.equal(Math.round(fullXp / halfXp), 2);
  assert.equal(fullXp, seasonFantasyPoints(full, "FWD", 0) / GAMEWEEKS_PER_SEASON);
});

// -- the resulting scale has to be plausible ---------------------------------

test("the xP scale ranks elite forward above elite defender above elite keeper", () => {
  const fwd = seasonExpectedPointsPerGameweek(line({ appearances: 38, goals: 25, assists: 10, yellow: 5 }), "FWD", 0.4);
  const def = seasonExpectedPointsPerGameweek(line({ appearances: 38, goals: 3, assists: 5, yellow: 6 }), "DEF", 0.45);
  const gk = seasonExpectedPointsPerGameweek(line({ appearances: 38, yellow: 1 }), "GK", 0.45);
  assert.ok(fwd > def && def > gk, `expected FWD>DEF>GK, got ${fwd} ${def} ${gk}`);
  // Sanity band: an elite season should land in single digits per gameweek,
  // not 0.5 and not 40. A change that breaks this broke the units.
  assert.ok(fwd > 4 && fwd < 9, `elite forward xP out of band: ${fwd}`);
  assert.ok(gk > 2 && gk < 6, `elite keeper xP out of band: ${gk}`);
});

test("a fringe player lands near zero without going negative on appearances alone", () => {
  const xp = seasonExpectedPointsPerGameweek(line({ appearances: 3 }), "MID", 0.3);
  assert.ok(xp > 0 && xp < 0.5, `fringe xP out of band: ${xp}`);
});

// -- multi-season weighting --------------------------------------------------

test("historicalExpectedPoints weights the most recent season heaviest", () => {
  // Two seasons only. Three would be a degenerate comparison under [3,2,1]:
  // a strong season in the newest slot scores 3, and strong seasons in the
  // two older slots score 2+1, so both arrangements tie and the test would
  // pass whatever the weights were.
  const strong = line({ appearances: 38, goals: 20 });
  const weak = line({ appearances: 38, goals: 0 });
  const recentStrong = historicalExpectedPoints([strong, weak], "FWD", [0, 0]);
  const recentWeak = historicalExpectedPoints([weak, strong], "FWD", [0, 0]);
  assert.ok(
    recentStrong.xp > recentWeak.xp,
    `recent form should dominate: ${recentStrong.xp} vs ${recentWeak.xp}`,
  );
  // And the gap should be the weight difference, not a rounding artefact.
  assert.ok(recentStrong.xp - recentWeak.xp > 0.3);
});

test("historicalExpectedPoints skips seasons the player never featured in rather than scoring them zero", () => {
  const played = line({ appearances: 38, goals: 10 });
  const absent = line({ appearances: 0 });
  const withGap = historicalExpectedPoints([played, absent, absent], "FWD", [0, 0, 0]);
  const soloSeason = historicalExpectedPoints([played], "FWD", [0]);
  assert.equal(withGap.xp, soloSeason.xp, "an absent season must not dilute a real one");
  assert.equal(withGap.seasonsUsed, 1);
});

test("historicalExpectedPoints returns null when there is no usable history at all", () => {
  assert.equal(historicalExpectedPoints([], "MID", []), null);
  assert.equal(historicalExpectedPoints([line({ appearances: 0 })], "MID", [0]), null);
});

// -- in-season blend ---------------------------------------------------------

test("blendWithCurrentSeason returns the prior untouched before a ball is kicked", () => {
  assert.equal(blendWithCurrentSeason(5, 999, 0), 5);
});

test("blendWithCurrentSeason weights history and this season equally at the prior's own horizon", () => {
  // prior 4.0, currently averaging 6.0, exactly PRIOR_WEIGHT_GAMEWEEKS played
  const blended = blendWithCurrentSeason(4, 6 * PRIOR_WEIGHT_GAMEWEEKS, PRIOR_WEIGHT_GAMEWEEKS);
  assert.equal(blended, 5);
});

test("blendWithCurrentSeason lets a long season override a stale prior", () => {
  const blended = blendWithCurrentSeason(1, 6 * 34, 34);
  assert.ok(blended > 5, `late-season form should dominate, got ${blended}`);
});

test("blendWithCurrentSeason survives a player with no prior at all", () => {
  assert.equal(blendWithCurrentSeason(null, 20, 4), 5);
});

test("one explosive gameweek cannot crown a fringe player in September", () => {
  // 15 points in the opening week against a 1.0 prior. Without shrinkage this
  // would read 15.0 and top the entire pool.
  const blended = blendWithCurrentSeason(1, 15, 1);
  assert.ok(blended < 3.5, `shrinkage failed, got ${blended}`);
});

// -- cohort baseline ---------------------------------------------------------

const cohort = [
  { position: "MID", tier: "starter", xp: 2 },
  { position: "MID", tier: "starter", xp: 4 },
  { position: "MID", tier: "starter", xp: 9 },
  { position: "MID", tier: "fringe", xp: 0.2 },
  { position: "DEF", tier: "starter", xp: 5 },
];

test("baselineFromCohort takes the median of the matching position and tier", () => {
  assert.equal(baselineFromCohort(cohort, "MID", "starter"), 4);
});

test("baselineFromCohort resists a superstar dragging the cohort up", () => {
  const withSuperstar = [...cohort, { position: "MID", tier: "starter", xp: 40 }];
  const baseline = baselineFromCohort(withSuperstar, "MID", "starter");
  assert.ok(baseline < 7, `median should absorb the outlier, got ${baseline}`);
});

test("baselineFromCohort returns null when the cohort is empty rather than guessing", () => {
  assert.equal(baselineFromCohort(cohort, "GK", "starter"), null);
  assert.equal(baselineFromCohort([], "MID", "starter"), null);
});

// -- expectedPointsFor: the honesty channel ----------------------------------

test("expectedPointsFor reports measured history as basis history", () => {
  const result = expectedPointsFor({
    seasonLines: [line({ appearances: 38, goals: 20 })],
    position: "FWD",
    cleanSheetRates: [0],
  });
  assert.equal(result.basis, "history");
  assert.equal(result.seasonsUsed, 1);
  assert.ok(result.xp > 0);
});

test("expectedPointsFor marks a cohort fallback as an estimate, never as history", () => {
  const result = expectedPointsFor({ seasonLines: [], position: "MID", tier: "starter", cohort });
  assert.equal(result.basis, "estimate");
  assert.equal(result.xp, 4);
});

test("expectedPointsFor returns a null xP and null basis when it genuinely cannot know", () => {
  // No history, no cohort peer, no games played. The UI must show its
  // placeholder rather than a number nobody can stand behind.
  const result = expectedPointsFor({ seasonLines: [], position: "GK", tier: "starter", cohort: [] });
  assert.equal(result.xp, null);
  assert.equal(result.basis, null);
});

test("expectedPointsFor prefers a no-history player's real current season over a cohort guess", () => {
  const result = expectedPointsFor({
    seasonLines: [],
    position: "MID",
    tier: "starter",
    cohort,
    currentSeasonPoints: 60,
    gameweeksPlayed: 10,
  });
  assert.equal(result.basis, "blended");
  assert.equal(result.xp, 6);
});

test("expectedPointsFor switches to blended once the season is under way", () => {
  const result = expectedPointsFor({
    seasonLines: [line({ appearances: 38, goals: 20 })],
    position: "FWD",
    cleanSheetRates: [0],
    currentSeasonPoints: 40,
    gameweeksPlayed: 8,
  });
  assert.equal(result.basis, "blended");
});

// -- normalizeSeasonLine: API-Football's own field quirks --------------------

test("normalizeSeasonLine reads API-Football's misspelled appearences field", () => {
  const normalized = normalizeSeasonLine({ games: { appearences: 21, minutes: 1800, lineups: 19 } });
  assert.equal(normalized.appearances, 21);
  assert.equal(normalized.minutes, 1800);
});

test("normalizeSeasonLine still reads a correctly spelled appearances field", () => {
  assert.equal(normalizeSeasonLine({ games: { appearances: 7 } }).appearances, 7);
});

test("normalizeSeasonLine pulls second yellows out of the yellowred field", () => {
  const normalized = normalizeSeasonLine({ cards: { yellow: 6, yellowred: 1, red: 2 } });
  assert.equal(normalized.yellow, 6);
  assert.equal(normalized.yellowRed, 1);
  assert.equal(normalized.red, 2);
});

test("normalizeSeasonLine treats missing blocks as zeroes rather than throwing", () => {
  const normalized = normalizeSeasonLine({});
  assert.equal(normalized.goals, 0);
  assert.equal(normalized.appearances, 0);
  assert.equal(normalizeSeasonLine(null), null);
});

// -- club clean-sheet rates --------------------------------------------------

const matches = [
  { homeTeam: "Arsenal", awayTeam: "Chelsea", score: { home: 2, away: 0 } },
  { homeTeam: "Chelsea", awayTeam: "Arsenal", score: { home: 1, away: 1 } },
  { homeTeam: "Arsenal", awayTeam: "Everton", score: { home: 0, away: 0 } },
];

test("clubCleanSheetRates counts a shut-out for the side that conceded nothing", () => {
  const rates = clubCleanSheetRates(matches);
  // Arsenal: 3 played, conceded 0 against Chelsea (h) and Everton (h) = 2/3
  assert.equal(Math.round(rates.get("Arsenal") * 100) / 100, 0.67);
  // Chelsea: 2 played, conceded 0 in neither (shipped 2, then 1) = 0
  assert.equal(rates.get("Chelsea"), 0);
});

test("clubCleanSheetRates credits both sides in a goalless draw", () => {
  const rates = clubCleanSheetRates([{ homeTeam: "A", awayTeam: "B", score: { home: 0, away: 0 } }]);
  assert.equal(rates.get("A"), 1);
  assert.equal(rates.get("B"), 1);
});

test("clubCleanSheetRates ignores fixtures with no result yet", () => {
  const rates = clubCleanSheetRates([{ homeTeam: "A", awayTeam: "B", score: { home: null, away: null } }]);
  assert.equal(rates.size, 0);
});

// -- weightedCleanSheetRate: a mid-season transfer's clean-sheet rate -------

test("weightedCleanSheetRate averages across clubs weighted by appearances", () => {
  const clubApps = new Map([
    ["Arsenal", 30],
    ["Chelsea", 10],
  ]);
  const rates = new Map([
    ["Arsenal", 0.5],
    ["Chelsea", 0.1],
  ]);
  // (30*0.5 + 10*0.1) / 40 = 16/40 = 0.4
  assert.equal(weightedCleanSheetRate(clubApps, rates), 0.4);
});

test("weightedCleanSheetRate treats a club missing from the rates map as a 0 rate rather than dropping it", () => {
  const clubApps = new Map([["Coventry City", 20]]);
  assert.equal(weightedCleanSheetRate(clubApps, new Map()), 0);
});

test("weightedCleanSheetRate returns 0 for an empty or missing breakdown", () => {
  assert.equal(weightedCleanSheetRate(new Map(), new Map([["Arsenal", 0.5]])), 0);
  assert.equal(weightedCleanSheetRate(null, new Map()), 0);
});
