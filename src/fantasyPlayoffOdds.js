// Playoff odds: a Monte Carlo projection of each manager's probability of
// finishing the H2H regular season in a playoff spot, run against the
// league's own remaining schedule (src/draftLogic.js's roundRobinSchedule
// shape: [{ gameweek, homeUserId, awayUserId, homeScore, awayScore }]).
//
// Neither ESPN nor Yahoo ships this natively; third-party tools exist
// specifically to fill the gap, which is the product case for building it
// here. It is also cheap: the whole thing is arithmetic over a schedule that
// tops out around 200 fixtures for the largest league (MAX_LEAGUE_SIZE in
// src/fantasy.js), no fetch, no D1.
//
// Pure: array/object in, value out. No DOM, no fetch, no D1, same contract as
// fantasyGameweek.js / fantasyRecap.js / fantasyDemo.js.
//
// -- What "decided" means -----------------------------------------------------
// A fixture is decided once it carries both scores (`homeScore != null &&
// awayScore != null`), the same test fantasyRecap.js already uses, never a
// gameweek-number comparison. That is deliberately the ONLY notion of
// "current" this module needs: fantasyCalendar.js's window model (see its own
// header) already explains why a fixture's gameweek label can move, but this
// module never groups by gameweek at all, so it cannot inherit that failure
// mode by not asking the question in the first place. A caller passing a
// currentGameweek here would be a second, parallel "what counts as settled"
// rule that could drift from the one the score-writing path already used.
//
// -- Why a manager's future score is a distribution, not a number -----------
// Summing a starting XI's xP (src/fantasyExpectedPoints.js) gives the MEAN of
// a manager's next gameweek. A single mean, replayed forward with no spread,
// would make every remaining fixture a coin flip decided by whoever's mean is
// marginally higher and would understate how often a mid-table manager gets
// hot and catches a leader. The spread comes from two places, in order of
// trust: the manager's own realised weekly totals this season once there are
// enough of them (a real, measured sample beats a guess), falling back to a
// squad-derived estimate (see SQUAD_SPREAD_COEFFICIENT_OF_VARIATION) when
// there is not yet a trustworthy sample - never a flat invented constant.
//
// -- Honesty: clinched/eliminated are computed facts, not samples ------------
// Before simulating anything, every manager's guaranteed floor (their current
// record points; it can only go up) and ceiling (floor plus 3 points for every
// remaining fixture, i.e. winning every one of them) are computed from the
// schedule alone. A manager is ELIMINATED when at least `playoffSpots` other
// managers have ALREADY BANKED more points than this manager's ceiling - a
// fact that needs no assumption about how anyone's remaining games go, since
// banked points cannot be taken away. A manager is CLINCHED when fewer than
// `playoffSpots` other managers could even reach this manager's floor in
// their own best case. Both checks are the standard, simple sports
// "elimination number" bound: sound (never wrongly clinches or eliminates)
// but conservative, not the tighter combinatorial (max-flow / "baseball
// elimination") bound that also reasons about who plays whom among the
// chasers. That tighter bound could catch a few extra true eliminations a
// little earlier; it is not implemented here because the simple bound is
// airtight on its own and a false "still alive" is a far safer failure mode
// for a probability display than a false "eliminated" would be. Only
// managers who are neither get a sampled probability, because reporting a
// sampled 0% or 100% for an already-decided case is a different (and false)
// claim from reporting the fact.
//
// -- Determinism -----------------------------------------------------------
// One mulberry32 stream is seeded once per call from `seed` (src/
// seededRandom.js) and consumed in a fixed order (iteration, then each
// remaining fixture in schedule order, home draw then away draw), so the same
// league state and the same seed produce byte-identical odds on every call -
// required so the number does not jitter between page loads.

import { hashSeed, mulberry32 } from "./seededRandom.js";
import { standingsFromFixtures } from "./fantasyGameweek.js";
import { STARTING_SIZE } from "./fantasy.js";

// Top-level knobs -------------------------------------------------------------

// Not hardcoded to 4: a caller passes the league's own qualifying spot count
// (a future league setting, mirroring how fantasy_waiver_settings.mode is a
// per-league choice). This is only the value used when a caller has none yet.
export const DEFAULT_PLAYOFF_SPOTS = 4;

// See the convergence check in test/fantasy-playoff-odds.test.js: running the
// same seeded stream to 2500 and to 5000 iterations moves every manager's
// odds by well under a percentage point in a genuinely contested league, and
// 5000 iterations of a ~200-fixture schedule still runs in well under a
// second (no fetch, no D1, pure arithmetic). Doubling again buys materially
// less stability than the first doubling did, which is the point at which
// more iterations is just spending cycles rather than buying confidence.
export const DEFAULT_ITERATIONS = 5000;

// Fewer than this many realised gameweek totals and a sample stddev is mostly
// noise (three points barely constrain a spread at all); at or above it, a
// manager's own scoring volatility is a better signal than a guess built from
// their squad alone.
export const MIN_REALISED_SAMPLES_FOR_SPREAD = 3;

// Squad-derived fallback spread, expressed as a coefficient of variation
// (stddev / mean) applied to a manager's projected weekly mean. Not an
// invented number: fantasyDemo.js's seeded per-player score generator already
// calibrates an average ("starter" tier) player's weekly score at mean 5.6 /
// stddev 3.2 (src/fantasyDemo.js's DEMO_TIER_MEAN.starter / DEMO_TIER_STDDEV.
// starter), a CV of 3.2 / 5.6 ≈ 0.571. A starting XI is STARTING_SIZE (src/
// fantasy.js) roughly-independent performances summed together; summing N
// independent draws adds variance linearly while the mean also adds linearly,
// so the SUM's coefficient of variation is the single player's CV divided by
// sqrt(N) - the same diversification an 11-man XI gets in reality, where one
// player's blank week is rarely everyone's blank week. The constant is
// written out as a literal rather than imported from fantasyDemo.js, because
// fantasyDemo.js is a leaf module that itself depends on the real modules
// this file sits beside (fantasyGameweek.js, fantasy.js); importing it here
// would invert that dependency direction for the sake of two numbers.
export const SQUAD_SPREAD_COEFFICIENT_OF_VARIATION = (3.2 / 5.6) / Math.sqrt(STARTING_SIZE);

// -- Fixture bookkeeping ------------------------------------------------------

function isDecidedFixture(fixture) {
  return fixture?.homeScore != null && fixture?.awayScore != null;
}

// How many undecided fixtures each manager still has on the schedule. A
// manager absent from every remaining fixture (their run of games is done,
// or none were ever scheduled for them) gets 0 rather than being missing from
// the map, so callers never have to guard a lookup miss as "still to play".
export function remainingGamesByUser(remainingFixtures) {
  const counts = new Map();
  for (const fixture of remainingFixtures ?? []) {
    if (fixture?.homeUserId != null) counts.set(fixture.homeUserId, (counts.get(fixture.homeUserId) ?? 0) + 1);
    if (fixture?.awayUserId != null) counts.set(fixture.awayUserId, (counts.get(fixture.awayUserId) ?? 0) + 1);
  }
  return counts;
}

// Each manager's guaranteed floor (current record points; standingsFromFixtures'
// win=3/draw=1/loss=0 convention, and it can only increase from here) and
// ceiling (floor plus 3 for every remaining fixture, i.e. winning all of
// them). `standings` is standingsFromFixtures' own output over the DECIDED
// fixtures only, so these bounds never assume anything about the future
// beyond "how many games are left".
export function pointsBoundsByUser({ standings, remainingByUser }) {
  const bounds = new Map();
  for (const row of standings ?? []) {
    const remaining = remainingByUser?.get?.(row.userId) ?? 0;
    bounds.set(row.userId, {
      floor: row.recordPoints,
      ceiling: row.recordPoints + remaining * 3,
      pointsFor: row.pointsFor,
      remainingGames: remaining,
    });
  }
  return bounds;
}

// See the module header's "Honesty" section for why each check is sound on
// its own (no assumption about how anyone else's remaining games interlock).
export function clinchStatus({ bounds, playoffSpots }) {
  const entries = [...(bounds ?? new Map())];
  const statuses = new Map();
  for (const [userId, mine] of entries) {
    const others = entries.filter(([id]) => id !== userId).map(([, b]) => b);
    const alreadyAheadOfMyCeiling = others.filter((b) => b.floor > mine.ceiling).length;
    if (alreadyAheadOfMyCeiling >= playoffSpots) {
      statuses.set(userId, "eliminated");
      continue;
    }
    // "Could still catch me" uses >= (a tie counts), because a tie's real
    // resolution depends on the pointsFor/name tie-break standingsFromFixtures
    // applies, which this bound deliberately does not try to predict; treating
    // a possible tie as a threat is the conservative (never-wrongly-clinched)
    // choice.
    const couldStillCatchMe = others.filter((b) => b.ceiling >= mine.floor).length;
    statuses.set(userId, couldStillCatchMe < playoffSpots ? "clinched" : "contention");
  }
  return statuses;
}

// -- Spread --------------------------------------------------------------------

// See MIN_REALISED_SAMPLES_FOR_SPREAD and SQUAD_SPREAD_COEFFICIENT_OF_VARIATION
// above for which source is trusted and why. `meanWeeklyPoints` is the
// caller's already-summed starting-XI xP for one gameweek (src/
// fantasyExpectedPoints.js is where that number itself comes from; this
// module takes it as given rather than recomputing it, to stay decoupled from
// the player pool).
export function projectedWeeklySpread({ meanWeeklyPoints, weeklyScores } = {}) {
  const samples = (weeklyScores ?? []).filter((value) => Number.isFinite(value));
  if (samples.length >= MIN_REALISED_SAMPLES_FOR_SPREAD) {
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    // Bessel's correction (n - 1): these are a SAMPLE of a manager's true
    // weekly-scoring distribution, not the whole population of it, and
    // dividing by n instead would systematically understate the spread.
    const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (samples.length - 1);
    return Math.sqrt(variance);
  }
  const mean = Number.isFinite(meanWeeklyPoints) ? meanWeeklyPoints : 0;
  return Math.max(0, mean) * SQUAD_SPREAD_COEFFICIENT_OF_VARIATION;
}

// One Box-Muller normal draw from a [0, 1)-uniform RNG. `u1` is floored away
// from exactly 0 (mulberry32 can return it) because log(0) is -Infinity and
// would poison the draw.
function sampleNormal(rng, mean, stddev) {
  if (!(stddev > 0)) return mean;
  const u1 = Math.max(rng(), Number.EPSILON);
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * stddev;
}

// One sampled gameweek total for a manager: never negative (a real starting
// XI's floor is a handful of appearance points, not a plausible negative
// total; clamping stops a freak sampled draw from producing a nonsensical
// score) and rounded to a whole number, since every real fantasy score is one.
function sampleWeeklyScore(rng, projection) {
  const mean = projection?.mean ?? 0;
  const stddev = projection?.stddev ?? 0;
  return Math.max(0, Math.round(sampleNormal(rng, mean, stddev)));
}

// -- The projection --------------------------------------------------------------

function standingsRowShape(row, bounds) {
  const b = bounds.get(row.userId) ?? {};
  return {
    userId: row.userId,
    name: row.name,
    played: row.played,
    wins: row.wins,
    draws: row.draws,
    losses: row.losses,
    recordPoints: row.recordPoints,
    pointsFor: row.pointsFor,
    pointsAgainst: row.pointsAgainst,
    remainingGames: b.remainingGames ?? 0,
  };
}

// The whole projection. `members` is [{ userId, name }] (fantasyGameweek.js's
// own shape); `fixtures` is the full-season H2H schedule, decided fixtures
// carrying both scores and undecided ones missing either
// (src/draftLogic.js's roundRobinSchedule output, plus real results merged
// in, is exactly this shape); `managers` is [{ userId, meanWeeklyPoints,
// weeklyScores }], one entry per member (a member absent from it, or missing
// meanWeeklyPoints, projects to 0 for the rest of the season rather than
// throwing - an empty/unfilled roster is a real, if extreme, state).
//
// `playoffSpots` is a per-league setting the caller supplies (see
// DEFAULT_PLAYOFF_SPOTS); a league whose member count does not exceed it has
// no meaningful cut to project at all (everyone already qualifies by
// definition), so that case is reported as `tooSmallForPlayoffs` with every
// manager `clinched` at probability 1, and the simulation never runs.
export function simulatePlayoffOdds({
  members,
  fixtures,
  managers = [],
  playoffSpots = DEFAULT_PLAYOFF_SPOTS,
  iterations = DEFAULT_ITERATIONS,
  seed = "playoff-odds",
} = {}) {
  const roster = members ?? [];
  const requestedSpots =
    Number.isFinite(playoffSpots) && playoffSpots > 0 ? Math.floor(playoffSpots) : DEFAULT_PLAYOFF_SPOTS;

  if (!roster.length) {
    return { playoffSpots: requestedSpots, iterations: 0, tooSmallForPlayoffs: true, standings: [] };
  }

  const tooSmallForPlayoffs = requestedSpots >= roster.length;
  const spots = Math.max(1, Math.min(requestedSpots, roster.length));

  const allFixtures = fixtures ?? [];
  const decided = allFixtures.filter(isDecidedFixture);
  const remaining = allFixtures.filter((fixture) => !isDecidedFixture(fixture));

  const currentStandings = standingsFromFixtures(decided, roster);
  const remainingByUser = remainingGamesByUser(remaining);
  const bounds = pointsBoundsByUser({ standings: currentStandings, remainingByUser });

  if (tooSmallForPlayoffs) {
    return {
      playoffSpots: spots,
      iterations: 0,
      tooSmallForPlayoffs: true,
      standings: currentStandings.map((row) => ({ ...standingsRowShape(row, bounds), status: "clinched", probability: 1 })),
    };
  }

  const statusByUser = clinchStatus({ bounds, playoffSpots: spots });

  const managerByUser = new Map((managers ?? []).map((manager) => [manager.userId, manager]));
  const projectionByUser = new Map(
    roster.map((member) => {
      const info = managerByUser.get(member.userId) ?? {};
      const mean = Number.isFinite(info.meanWeeklyPoints) ? info.meanWeeklyPoints : 0;
      return [member.userId, { mean, stddev: projectedWeeklySpread(info) }];
    }),
  );

  const hasContenders = [...statusByUser.values()].some((status) => status === "contention");
  const makeCounts = new Map(roster.map((member) => [member.userId, 0]));

  // Only worth spending cycles on when at least one manager's fate is not
  // already a computed fact; a league where the current gameweek has already
  // resolved everyone's status (a fully decided season, or a small league deep
  // into it) has nothing left for the RNG to decide.
  if (hasContenders && iterations > 0) {
    const rng = mulberry32(hashSeed(seed, "fantasyPlayoffOdds:v1"));
    for (let i = 0; i < iterations; i++) {
      const simulated = decided.concat(
        remaining.map((fixture) => ({
          ...fixture,
          homeScore: sampleWeeklyScore(rng, projectionByUser.get(fixture.homeUserId)),
          awayScore: sampleWeeklyScore(rng, projectionByUser.get(fixture.awayUserId)),
        })),
      );
      const finalStandings = standingsFromFixtures(simulated, roster);
      for (let rank = 0; rank < spots && rank < finalStandings.length; rank++) {
        const userId = finalStandings[rank].userId;
        makeCounts.set(userId, (makeCounts.get(userId) ?? 0) + 1);
      }
    }
  }

  const standings = currentStandings.map((row) => {
    const status = statusByUser.get(row.userId);
    const probability =
      status === "clinched" ? 1 : status === "eliminated" ? 0 : (makeCounts.get(row.userId) ?? 0) / iterations;
    return { ...standingsRowShape(row, bounds), status, probability };
  });

  standings.sort(
    (a, b) =>
      b.probability - a.probability ||
      b.recordPoints - a.recordPoints ||
      b.pointsFor - a.pointsFor ||
      String(a.name).localeCompare(String(b.name)),
  );

  return { playoffSpots: spots, iterations, tooSmallForPlayoffs: false, standings };
}
