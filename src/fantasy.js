// Fantasy H2H draft league config: roster shape, formation rules, and position
// bucketing. Pure data + pure functions, no DOM/fetch, mirroring the
// competitions.js pattern (config as data, not scattered literals).

// Squad composition: a 15-man squad, 11 of them starting each gameweek under
// football's standard flexible-formation rule (1 GK, 3-5 DEF, 2-5 MID, 1-3 FWD,
// 11 total) — the same rule real-world Fantasy Premier League uses, chosen for
// familiarity over inventing a bespoke ruleset.
export const SQUAD_SLOTS = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
export const SQUAD_SIZE = Object.values(SQUAD_SLOTS).reduce((sum, n) => sum + n, 0); // 15

export const STARTING_LIMITS = {
  GK: { min: 1, max: 1 },
  DEF: { min: 3, max: 5 },
  MID: { min: 2, max: 5 },
  FWD: { min: 1, max: 3 },
};
export const STARTING_SIZE = 11;

// Max managers per league: caps the round-robin schedule so "members vs
// remaining gameweeks" never has to repeat or truncate awkwardly.
export const MAX_LEAGUE_SIZE = 10;

const POSITIONS = ["GK", "DEF", "MID", "FWD"];

// Validates a proposed starting XI: exactly STARTING_SIZE players, each
// position within its min/max, no position outside the four recognised ones.
// `players` is an array of { position } (or bare position strings).
export function validateFormation(players) {
  const counts = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const entry of players ?? []) {
    const position = typeof entry === "string" ? entry : entry?.position;
    if (!POSITIONS.includes(position)) return { valid: false, error: `unknown position: ${position}` };
    counts[position] += 1;
  }
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (total !== STARTING_SIZE) {
    return { valid: false, error: `starting XI must have exactly ${STARTING_SIZE} players, got ${total}` };
  }
  for (const position of POSITIONS) {
    const { min, max } = STARTING_LIMITS[position];
    if (counts[position] < min || counts[position] > max) {
      return { valid: false, error: `${position} count ${counts[position]} outside ${min}-${max}` };
    }
  }
  return { valid: true, error: null };
}

// football-data's /v4/teams/{id} squad endpoint returns a coarse, exactly
// four-value position field — no fuzzy matching needed for that path.
const SQUAD_POSITION_MAP = {
  Goalkeeper: "GK",
  Defence: "DEF",
  Midfield: "MID",
  Offence: "FWD",
};

// Match-detail lineup entries (the fallback player-pool source) can carry more
// granular free-text positions (e.g. "Right-Back", "Attacking Midfield").
// Best-effort keyword bucketing, documented as approximate.
export function bucketPosition(rawPosition) {
  if (!rawPosition) return null;
  const mapped = SQUAD_POSITION_MAP[rawPosition];
  if (mapped) return mapped;
  const value = String(rawPosition).toLowerCase();
  if (value.includes("keep")) return "GK";
  if (value.includes("back") || value.includes("defen")) return "DEF";
  if (value.includes("mid")) return "MID";
  return "FWD";
}

// FPL's own published scoring rules, minus the minutes-based appearance tiers
// (1pt for <60 mins, 2pts for 60+) — this codebase has no per-player minutes
// data, only lineup/bench membership and a flat subs[] list, so appearance is
// a flat value regardless of minutes. Documented simplification, not a bug.
export const SCORING = {
  goal: { GK: 6, DEF: 6, MID: 5, FWD: 4 },
  assist: 3,
  cleanSheet: { GK: 4, DEF: 4, MID: 1, FWD: 0 },
  appearance: 2,
  yellowCard: -1,
  redCard: -3,
  ownGoal: -2,
};
