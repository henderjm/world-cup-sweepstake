// Seeded injuries and seeded form streaks for the try-a-draft demo (the
// Football Manager texture: a squad copes with knocks and cold runs, not just
// an independent score draw every week). Pure and deterministic: given the
// same seed, playerId and gameweek count, both derivations replay identically,
// which the season engine's "same seed, same human decisions -> same season"
// requirement depends on (see CLAUDE.md).
//
// Both are precomputed once per player for the WHOLE season up front (not
// incrementally per chunk) because neither depends on any human decision - an
// injury or a form streak lands on a player from the seed alone, exactly like
// seededPlayerGameweekPoints' own per-(seed,playerId,gameweek) draw. That
// means a much later desk's "how did my treatment table look" news is always
// reading off the same windows/series an earlier chunk already used, with no
// risk of the two disagreeing.

import { hashSeed, mulberry32 } from "./seededRandom.js";

// Roughly one knock every couple of seasons per player (2% a week over 38
// weeks): high enough that a 6-chunk demo season usually surfaces two or
// three injuries across a 15-man squad (the "waiver demand" this exists to
// create), low enough that it doesn't read as a war zone. Deliberately NOT
// tiered by position or minutes: "higher-minutes players are not immune"
// means everyone who actually plays is exposed to the same weekly risk, not
// that fringe players are somehow more fragile.
export const INJURY_CHANCE_PER_GAMEWEEK = 0.02;
export const INJURY_MIN_GAMEWEEKS = 1;
export const INJURY_MAX_GAMEWEEKS = 4;

// Walks gameweeks 1..totalGameweeks once, seeded by (seed, playerId): at each
// non-injured week there is a small chance of picking up a knock lasting 1-4
// games, after which the walk resumes clear of it. Returns
// [{ start, end }, ...] in ascending, non-overlapping order.
export function playerInjuryWindows(seed, playerId, totalGameweeks) {
  const rng = mulberry32(hashSeed(seed, playerId, "injury"));
  const windows = [];
  let gw = 1;
  while (gw <= totalGameweeks) {
    if (rng() < INJURY_CHANCE_PER_GAMEWEEK) {
      const span = INJURY_MIN_GAMEWEEKS + Math.floor(rng() * (INJURY_MAX_GAMEWEEKS - INJURY_MIN_GAMEWEEKS + 1));
      const end = Math.min(gw + span - 1, totalGameweeks);
      windows.push({ start: gw, end });
      gw = end + 1;
    } else {
      gw += 1;
    }
  }
  return windows;
}

export function isInjuredAtGameweek(windows, gameweek) {
  return (windows ?? []).some((window) => gameweek >= window.start && gameweek <= window.end);
}

// Total gameweeks a player has spent (or will spend) injured across the whole
// season - used by the report card's "worst injury luck" derivation.
export function totalInjuredGameweeks(windows) {
  return (windows ?? []).reduce((sum, window) => sum + (window.end - window.start + 1), 0);
}

// Form: a mean-reverting random walk rather than an independent draw per
// gameweek, so a player can run hot or cold for SEVERAL consecutive weeks
// (what makes benching or waiver-ing a slumping player a real decision)
// instead of every week being its own coin flip. `FORM_DECAY` pulls the walk
// back toward neutral each week (stops an early hot streak drifting to an
// implausible permanent extreme); `FORM_NOISE` is how much a single week can
// move it. The multiplier this produces (formMultiplierAt) is centered on 1.
const FORM_DECAY = 0.85;
const FORM_NOISE = 0.35;
export const FORM_SWING = 0.4; // the walk's [-1, 1] range maps to a [0.6, 1.4] multiplier

export function playerFormSeries(seed, playerId, totalGameweeks) {
  const rng = mulberry32(hashSeed(seed, playerId, "form"));
  const series = [];
  let level = 0;
  for (let gw = 1; gw <= totalGameweeks; gw++) {
    level = Math.max(-1, Math.min(1, level * FORM_DECAY + (rng() * 2 - 1) * FORM_NOISE));
    series.push(level);
  }
  return series;
}

export function formMultiplierAt(series, gameweek) {
  const level = series?.[gameweek - 1] ?? 0;
  return 1 + level * FORM_SWING;
}
