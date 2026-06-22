import { STAGE_BONUSES, normalizeTeamName } from "./domain.js";
import { isFinished } from "./format.js";
import { R16, QF, SF, THIRD, FINAL, groupLetter, seedR32 } from "./bracket.js";

// Monte Carlo projection of where the prize money lands.
//
// Remaining group games are simulated into final group tables; the 32 qualifiers are
// then slotted into the *real* fixed 2026 knockout bracket (see bracket.js) and played
// to a champion. Earlier this used a generic strength-seeded bracket because the real
// pairings are not in the feed; the pathways are public and fixed, so we now seed them
// for real. The output is still a projection (team strengths are estimated), surfaced
// as such in the UI.
//
// `pins` (optional) is a Map<matchId, "home"|"away"|"draw"> of forced outcomes for
// remaining group games, powering the what-if explorer.

// Seeded strength prior on a 0..10 scale. Adjusted at runtime by tournament goal
// difference so far. Defaults to 5 for anything unmapped.
const RATINGS = {
  Brazil: 8.7, France: 8.7, Spain: 8.6, Argentina: 8.6, England: 8.4,
  Germany: 8.2, Portugal: 8.1, Netherlands: 8.0,
  Belgium: 7.3, Croatia: 7.2, Uruguay: 7.0, Morocco: 7.0, Switzerland: 6.7,
  Japan: 6.7, Mexico: 6.6, USA: 6.6, Colombia: 6.6, Senegal: 6.5, Sweden: 6.4,
  Ecuador: 6.0, "South Korea": 6.0, Australia: 5.8, Iran: 5.8, Norway: 6.2,
  Canada: 5.6, Egypt: 5.6, "Ivory Coast": 5.6, Austria: 5.8, Scotland: 5.6,
  Turkey: 5.7, Paraguay: 5.4, Ghana: 5.4, Algeria: 5.4, Nigeria: 5.6,
  "Saudi Arabia": 4.8, Qatar: 4.6, Tunisia: 4.9, Panama: 4.4, Iraq: 4.4,
  Jordan: 4.2, Uzbekistan: 4.4, "South Africa": 4.6, "New Zealand": 4.2,
  "Cape Verde": 4.0, Bosnia: 5.0, Czech: 5.2, Haiti: 3.6, Curacao: 3.4, DRC: 4.6,
};

const ENTRY_BONUS = STAGE_BONUSES.LAST_32;
const ROUND_BONUS = {
  r16: STAGE_BONUSES.LAST_16,
  qf: STAGE_BONUSES.QUARTER_FINALS,
  sf: STAGE_BONUSES.SEMI_FINALS,
};
const THIRD_PLACE_BONUS = STAGE_BONUSES.THIRD_PLACE;
const FINAL_WINNER_BONUS = STAGE_BONUSES.FINAL_WINNER;
const FINAL_RUNNER_UP_BONUS = STAGE_BONUSES.FINAL_RUNNER_UP;

const FACTORIAL = [1, 1, 2, 6, 24, 120, 720, 5040, 40320, 362880, 3628800];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function poisson(rng, lambda) {
  const limit = Math.exp(-lambda);
  let product = rng();
  let goals = 0;
  while (product > limit) {
    goals += 1;
    product *= rng();
  }
  return goals;
}

function blankRecord(team) {
  return { team, played: 0, points: 0, goalsFor: 0, goalsAgainst: 0 };
}

function applyResult(record, scored, conceded) {
  record.played += 1;
  record.goalsFor += scored;
  record.goalsAgainst += conceded;
  if (scored > conceded) record.points += 3;
  else if (scored === conceded) record.points += 1;
}

function goalDifference(record) {
  return record.goalsFor - record.goalsAgainst;
}

function compareRecords(a, b) {
  return (
    b.points - a.points ||
    goalDifference(b) - goalDifference(a) ||
    b.goalsFor - a.goalsFor ||
    (b.rating ?? 5) - (a.rating ?? 5) ||
    a.team.localeCompare(b.team)
  );
}

function expectedGoals(ratingA, ratingB) {
  const base = 1.35;
  const swing = 0.3 * (ratingA - ratingB);
  return [Math.max(0.2, base + swing), Math.max(0.2, base - swing)];
}

function simulateScoreline(rng, ratingA, ratingB) {
  const [lambdaA, lambdaB] = expectedGoals(ratingA, ratingB);
  return [poisson(rng, lambdaA), poisson(rng, lambdaB)];
}

// Scoreline for a pinned group game: sample from the model but keep only scorelines
// that match the forced outcome, so goal margins stay plausible. Falls back to a
// minimal scoreline if the constrained draw is unlucky.
function pinnedScoreline(rng, ratingA, ratingB, outcome) {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const [gh, ga] = simulateScoreline(rng, ratingA, ratingB);
    if (outcome === "home" && gh > ga) return [gh, ga];
    if (outcome === "away" && ga > gh) return [gh, ga];
    if (outcome === "draw" && gh === ga) return [gh, ga];
  }
  if (outcome === "draw") return [1, 1];
  return outcome === "home" ? [1, 0] : [0, 1];
}

function decideKnockout(rng, a, b, ratingOf) {
  const [ga, gb] = simulateScoreline(rng, ratingOf(a), ratingOf(b));
  if (ga > gb) return a;
  if (gb > ga) return b;
  const pA = ratingOf(a) / (ratingOf(a) + ratingOf(b));
  return rng() < pA ? a : b;
}

// Closed-form match outcome probabilities from the same Poisson model, used for the
// deterministic projected bracket's per-tie odds (no RNG, so it is stable).
function knockoutWinProbability(ratingA, ratingB) {
  const [lambdaA, lambdaB] = expectedGoals(ratingA, ratingB);
  let homeWin = 0;
  let draw = 0;
  for (let i = 0; i < FACTORIAL.length; i += 1) {
    const pi = Math.exp(-lambdaA) * Math.pow(lambdaA, i) / FACTORIAL[i];
    for (let j = 0; j < FACTORIAL.length; j += 1) {
      const pj = Math.exp(-lambdaB) * Math.pow(lambdaB, j) / FACTORIAL[j];
      if (i > j) homeWin += pi * pj;
      else if (i === j) draw += pi * pj;
    }
  }
  const share = ratingA / (ratingA + ratingB);
  return homeWin + draw * share;
}

function buildBaseRecords(groups, groupMatches) {
  const records = new Map();
  groups.forEach((group) => {
    group.teams.forEach((team) => records.set(team, blankRecord(team)));
  });
  groupMatches.forEach((match) => {
    if (!isFinished(match.status)) return;
    const home = normalizeTeamName(match.homeTeam);
    const away = normalizeTeamName(match.awayTeam);
    if (!records.has(home) || !records.has(away)) return;
    if (!Number.isFinite(match.score?.home) || !Number.isFinite(match.score?.away)) return;
    applyResult(records.get(home), match.score.home, match.score.away);
    applyResult(records.get(away), match.score.away, match.score.home);
  });
  return records;
}

// Final group tables from a set of records: the sorted table per group, the eight best
// thirds (their group letters, best first) and the group-last teams worst-first.
function finalize(records, groups, groupLetters, ratingOf) {
  const finalTables = new Map();
  const thirds = [];
  const lastPlaced = [];
  groups.forEach((group, index) => {
    const letter = groupLetters[index];
    const table = group.teams
      .map((team) => ({ ...records.get(team), rating: ratingOf(team) }))
      .sort(compareRecords);
    if (letter) finalTables.set(letter, table.map((row) => row.team));
    thirds.push({ ...table[2], letter });
    lastPlaced.push(table[3]);
  });
  const bestThirdLetters = [...thirds]
    .sort(compareRecords)
    .slice(0, 8)
    .map((row) => row.letter)
    .filter(Boolean);
  const worstLast = [...lastPlaced].sort((a, b) => -compareRecords(a, b));
  return { finalTables, bestThirdLetters, worstLast };
}

// One deterministic, self-consistent bracket: remaining group games resolve to their
// most-likely result (favourite wins, near-equal strengths draw), then each tie's
// favourite advances. Per-tie odds come from knockoutWinProbability. This is the
// "most-likely" bracket the UI shows by default.
function deterministicResult(ratingHome, ratingAway, pin) {
  if (pin === "home") return [1, 0];
  if (pin === "away") return [0, 1];
  if (pin === "draw") return [1, 1];
  const diff = ratingHome - ratingAway;
  if (Math.abs(diff) < 0.2) return [1, 1];
  return diff > 0 ? [1, 0] : [0, 1];
}

function projectBracket(baseRecords, remainingByGroup, groups, groupLetters, ratingOf, pins) {
  const records = new Map();
  baseRecords.forEach((record, team) => records.set(team, { ...record }));
  remainingByGroup.forEach((fixtures) => {
    fixtures.forEach(({ home, away, id }) => {
      const pin = pins?.get(String(id)) ?? null;
      const [gh, ga] = deterministicResult(ratingOf(home), ratingOf(away), pin);
      applyResult(records.get(home), gh, ga);
      applyResult(records.get(away), ga, gh);
    });
  });

  const { finalTables, bestThirdLetters } = finalize(records, groups, groupLetters, ratingOf);
  const r32 = seedR32(finalTables, bestThirdLetters);

  const winners = new Map();
  const byNo = new Map();
  const known = (team) => team && team !== "Unknown";
  const play = (no, stage, home, away) => {
    let homeWin = 0.5;
    let winner = home;
    let loser = away;
    if (known(home) && known(away)) {
      homeWin = knockoutWinProbability(ratingOf(home), ratingOf(away));
      if (homeWin >= 0.5) { winner = home; loser = away; } else { winner = away; loser = home; }
    } else if (known(home)) { winner = home; loser = away; homeWin = 1; }
    else if (known(away)) { winner = away; loser = home; homeWin = 0; }
    const match = { no, stage, home, away, homeWin, winner, loser };
    winners.set(no, winner);
    byNo.set(no, match);
    return match;
  };
  const teamOf = (no) => winners.get(no);

  const r32Matches = r32.map((m) => play(m.no, "LAST_32", m.home, m.away));
  const r16Matches = R16.map((m) => play(m.no, "LAST_16", teamOf(m.from[0]), teamOf(m.from[1])));
  const qfMatches = QF.map((m) => play(m.no, "QUARTER_FINALS", teamOf(m.from[0]), teamOf(m.from[1])));
  const sfMatches = SF.map((m) => play(m.no, "SEMI_FINALS", teamOf(m.from[0]), teamOf(m.from[1])));
  const thirdMatch = play(THIRD.no, "THIRD_PLACE", byNo.get(101).loser, byNo.get(102).loser);
  const finalMatch = play(FINAL.no, "FINAL", teamOf(101), teamOf(102));

  return {
    rounds: [
      { stage: "LAST_32", matches: r32Matches },
      { stage: "LAST_16", matches: r16Matches },
      { stage: "QUARTER_FINALS", matches: qfMatches },
      { stage: "SEMI_FINALS", matches: sfMatches },
      { stage: "THIRD_PLACE", matches: [thirdMatch] },
      { stage: "FINAL", matches: [finalMatch] },
    ],
    champion: finalMatch.winner,
    runnerUp: finalMatch.loser,
  };
}

export function runForecast({
  groups,
  groupMatches,
  ownerByTeam,
  entrants,
  seed = 1,
  iterations = 5000,
  pins = null,
}) {
  const rng = mulberry32(seed);
  const groupLetters = groups.map((group) => groupLetter(group.name));
  const teamRatings = new Map();
  const baseRecords = buildBaseRecords(groups, groupMatches);

  baseRecords.forEach((record, team) => {
    const prior = RATINGS[team] ?? 5;
    const tournamentSwing = 0.18 * goalDifference(record);
    teamRatings.set(team, Math.max(2.5, Math.min(9.5, prior + tournamentSwing)));
  });
  const ratingOf = (team) => teamRatings.get(team) ?? 5;

  const remainingByGroup = new Map();
  groups.forEach((group) => remainingByGroup.set(group.name, []));
  groupMatches.forEach((match) => {
    if (isFinished(match.status)) return;
    const home = normalizeTeamName(match.homeTeam);
    const away = normalizeTeamName(match.awayTeam);
    const group = groups.find((g) => g.teams.includes(home) && g.teams.includes(away));
    if (group) remainingByGroup.get(group.name).push({ home, away, id: match.id });
  });

  const entrantNames = entrants.map((entrant) => entrant.name);
  const teamOwner = (team) => ownerByTeam.get(team) ?? null;

  const winCount = new Map(entrantNames.map((name) => [name, 0]));
  const runnerUpCount = new Map(entrantNames.map((name) => [name, 0]));
  const spoonCount = new Map(entrantNames.map((name) => [name, 0]));
  const pointsSum = new Map(entrantNames.map((name) => [name, 0]));
  const teamTitleCount = new Map([...baseRecords.keys()].map((team) => [team, 0]));
  const teamRunnerUpCount = new Map([...baseRecords.keys()].map((team) => [team, 0]));
  const teamSpoonCount = new Map([...baseRecords.keys()].map((team) => [team, 0]));

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const records = new Map();
    baseRecords.forEach((record, team) => records.set(team, { ...record }));

    // Remaining group games (pinned ones use a constrained scoreline).
    remainingByGroup.forEach((fixtures) => {
      fixtures.forEach(({ home, away, id }) => {
        const outcome = pins?.get(String(id)) ?? null;
        const [gh, ga] = outcome
          ? pinnedScoreline(rng, ratingOf(home), ratingOf(away), outcome)
          : simulateScoreline(rng, ratingOf(home), ratingOf(away));
        applyResult(records.get(home), gh, ga);
        applyResult(records.get(away), ga, gh);
      });
    });

    const { finalTables, bestThirdLetters, worstLast } = finalize(
      records,
      groups,
      groupLetters,
      ratingOf,
    );

    // Wooden spoon: worst confirmed group-last team. Track the team too, so each
    // entrant can be shown the team actually driving their spoon risk.
    const spoonTeam = worstLast[0]?.team;
    if (spoonTeam) {
      teamSpoonCount.set(spoonTeam, (teamSpoonCount.get(spoonTeam) ?? 0) + 1);
      const spoonOwner = teamOwner(spoonTeam);
      if (spoonOwner) spoonCount.set(spoonOwner, spoonCount.get(spoonOwner) + 1);
    }

    // Seed and play the real 2026 bracket.
    const r32 = seedR32(finalTables, bestThirdLetters);
    const bonus = new Map();
    r32.forEach(({ home, away }) => {
      bonus.set(home, ENTRY_BONUS);
      bonus.set(away, ENTRY_BONUS);
    });

    const winners = new Map();
    const byNo = new Map();
    const playMatch = (no, home, away, advanceBonus) => {
      const winner = decideKnockout(rng, home, away, ratingOf);
      const loser = winner === home ? away : home;
      if (advanceBonus != null) bonus.set(winner, advanceBonus);
      winners.set(no, winner);
      byNo.set(no, { winner, loser });
      return winner;
    };
    const teamOf = (no) => winners.get(no);

    r32.forEach((m) => playMatch(m.no, m.home, m.away, ROUND_BONUS.r16));
    R16.forEach((m) => playMatch(m.no, teamOf(m.from[0]), teamOf(m.from[1]), ROUND_BONUS.qf));
    QF.forEach((m) => playMatch(m.no, teamOf(m.from[0]), teamOf(m.from[1]), ROUND_BONUS.sf));
    SF.forEach((m) => {
      playMatch(m.no, teamOf(m.from[0]), teamOf(m.from[1]), null);
      bonus.set(byNo.get(m.no).loser, THIRD_PLACE_BONUS);
    });

    const champion = decideKnockout(rng, teamOf(101), teamOf(102), ratingOf);
    const runnerUp = champion === teamOf(101) ? teamOf(102) : teamOf(101);
    bonus.set(champion, FINAL_WINNER_BONUS);
    bonus.set(runnerUp, FINAL_RUNNER_UP_BONUS);

    teamTitleCount.set(champion, teamTitleCount.get(champion) + 1);
    const championOwner = teamOwner(champion);
    if (championOwner) winCount.set(championOwner, winCount.get(championOwner) + 1);
    teamRunnerUpCount.set(runnerUp, teamRunnerUpCount.get(runnerUp) + 1);
    const runnerUpOwner = teamOwner(runnerUp);
    if (runnerUpOwner) runnerUpCount.set(runnerUpOwner, runnerUpCount.get(runnerUpOwner) + 1);

    // Projected sweepstake score, consistent with the live leaderboard formula.
    const entrantScore = new Map(entrantNames.map((name) => [name, 0]));
    records.forEach((record, team) => {
      const owner = teamOwner(team);
      if (!owner) return;
      const score =
        record.points * 10 + goalDifference(record) * 2 + record.goalsFor + (bonus.get(team) ?? 0);
      entrantScore.set(owner, entrantScore.get(owner) + score);
    });
    entrantScore.forEach((score, name) => pointsSum.set(name, pointsSum.get(name) + score));
  }

  const teamTitleOdds = new Map();
  teamTitleCount.forEach((count, team) => teamTitleOdds.set(team, (count / iterations) * 100));
  const teamRunnerUpOdds = new Map();
  teamRunnerUpCount.forEach((count, team) => teamRunnerUpOdds.set(team, (count / iterations) * 100));
  const teamSpoonOdds = new Map();
  teamSpoonCount.forEach((count, team) => teamSpoonOdds.set(team, (count / iterations) * 100));

  const entrantsForecast = new Map();
  entrants.forEach((entrant) => {
    const winPct = (winCount.get(entrant.name) / iterations) * 100;
    const runnerUpPct = (runnerUpCount.get(entrant.name) / iterations) * 100;
    const spoonPct = (spoonCount.get(entrant.name) / iterations) * 100;
    const teams = entrant.teams.map((team) => normalizeTeamName(team));
    const bestTeam = teams.reduce((best, team) =>
      (teamTitleOdds.get(team) ?? 0) > (teamTitleOdds.get(best) ?? 0) ? team : best,
    );
    // The team most likely to land this entrant the runner-up prize as losing finalist
    // (drives the runner-up card, distinct from the title-odds team above).
    const runnerUpTeam = teams.reduce((best, team) =>
      (teamRunnerUpOdds.get(team) ?? 0) > (teamRunnerUpOdds.get(best) ?? 0) ? team : best,
    );
    // The team most likely to land this entrant the wooden spoon (drives the spoon card).
    const spoonTeam = teams.reduce((worst, team) =>
      (teamSpoonOdds.get(team) ?? 0) > (teamSpoonOdds.get(worst) ?? 0) ? team : worst,
    );
    entrantsForecast.set(entrant.name, {
      name: entrant.name,
      winPct,
      runnerUpPct,
      spoonPct,
      projectedPoints: Math.round(pointsSum.get(entrant.name) / iterations),
      expectedWinnings: (winPct / 100) * 100 + (runnerUpPct / 100) * 30 + (spoonPct / 100) * 30,
      bestTeam,
      bestTeamOdds: teamTitleOdds.get(bestTeam) ?? 0,
      runnerUpTeam,
      runnerUpTeamOdds: teamRunnerUpOdds.get(runnerUpTeam) ?? 0,
      spoonTeam,
      spoonTeamOdds: teamSpoonOdds.get(spoonTeam) ?? 0,
    });
  });

  const projectedBracket = projectBracket(
    baseRecords,
    remainingByGroup,
    groups,
    groupLetters,
    ratingOf,
    pins,
  );

  return { seed, iterations, entrants: entrantsForecast, teamTitleOdds, projectedBracket };
}
