import { STAGE_BONUSES, normalizeTeamName } from "./domain.js";
import { isFinished } from "./format.js";

// Monte Carlo projection of where the prize money lands.
//
// The data feed never carries the real 2026 knockout pairings (every knockout slot
// is "Unknown"), so this simulates remaining group games into final tables, takes the
// 32 qualifiers, and runs a strength-seeded generic bracket. The output is a
// projection, surfaced as such in the UI, not a claim about the real draw.

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

const KNOCKOUT_ENTRY_BONUS = STAGE_BONUSES.LAST_32;
const ROUND_BONUS = {
  r16: STAGE_BONUSES.LAST_16,
  qf: STAGE_BONUSES.QUARTER_FINALS,
  sf: STAGE_BONUSES.SEMI_FINALS,
};
const THIRD_PLACE_BONUS = STAGE_BONUSES.THIRD_PLACE;
const FINAL_WINNER_BONUS = STAGE_BONUSES.FINAL_WINNER;
const FINAL_RUNNER_UP_BONUS = STAGE_BONUSES.FINAL_RUNNER_UP;

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

function decideKnockout(rng, a, b, ratingOf) {
  const [ga, gb] = simulateScoreline(rng, ratingOf(a), ratingOf(b));
  if (ga > gb) return a;
  if (gb > ga) return b;
  const pA = ratingOf(a) / (ratingOf(a) + ratingOf(b));
  return rng() < pA ? a : b;
}

// Standard bracket seed order so the strongest qualifiers are spread apart
// (seed 1 only meets seed 2 in the final).
function bracketSeedOrder(size) {
  let order = [1, 2];
  while (order.length < size) {
    const sum = order.length * 2 + 1;
    const next = [];
    for (const seed of order) {
      next.push(seed);
      next.push(sum - seed);
    }
    order = next;
  }
  return order;
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

export function runForecast({
  groups,
  groupMatches,
  ownerByTeam,
  entrants,
  seed = 1,
  iterations = 5000,
}) {
  const rng = mulberry32(seed);
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
    if (group) remainingByGroup.get(group.name).push({ home, away });
  });

  const entrantNames = entrants.map((entrant) => entrant.name);
  const teamOwner = (team) => ownerByTeam.get(team) ?? null;

  const winCount = new Map(entrantNames.map((name) => [name, 0]));
  const runnerUpCount = new Map(entrantNames.map((name) => [name, 0]));
  const spoonCount = new Map(entrantNames.map((name) => [name, 0]));
  const pointsSum = new Map(entrantNames.map((name) => [name, 0]));
  const teamTitleCount = new Map([...baseRecords.keys()].map((team) => [team, 0]));

  const seedSlots = bracketSeedOrder(32);

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const records = new Map();
    baseRecords.forEach((record, team) => records.set(team, { ...record }));

    // Remaining group games.
    remainingByGroup.forEach((fixtures) => {
      fixtures.forEach(({ home, away }) => {
        const [gh, ga] = simulateScoreline(rng, ratingOf(home), ratingOf(away));
        applyResult(records.get(home), gh, ga);
        applyResult(records.get(away), ga, gh);
      });
    });

    // Final group tables.
    const thirds = [];
    const lastPlaced = [];
    const qualifiers = [];
    groups.forEach((group) => {
      const table = group.teams
        .map((team) => ({ ...records.get(team), rating: ratingOf(team) }))
        .sort(compareRecords);
      qualifiers.push(table[0].team, table[1].team);
      thirds.push(table[2]);
      lastPlaced.push(table[3]);
    });
    thirds.sort(compareRecords);
    thirds.slice(0, 8).forEach((row) => qualifiers.push(row.team));

    // Wooden spoon: worst confirmed group-last team.
    lastPlaced.sort((a, b) => -compareRecords(a, b));
    const spoonOwner = teamOwner(lastPlaced[0].team);
    if (spoonOwner) spoonCount.set(spoonOwner, spoonCount.get(spoonOwner) + 1);

    // Strength-seeded knockout bracket.
    const seededByStrength = [...qualifiers].sort((a, b) => ratingOf(b) - ratingOf(a));
    const bracket = seedSlots.map((seed) => seededByStrength[seed - 1]);
    const bonus = new Map(qualifiers.map((team) => [team, KNOCKOUT_ENTRY_BONUS]));

    const playRound = (teams, advanceBonus) => {
      const winners = [];
      for (let i = 0; i < teams.length; i += 2) {
        const winner = decideKnockout(rng, teams[i], teams[i + 1], ratingOf);
        bonus.set(winner, advanceBonus);
        winners.push(winner);
      }
      return winners;
    };

    const round16 = playRound(bracket, ROUND_BONUS.r16);
    const round8 = playRound(round16, ROUND_BONUS.qf);
    const semiFinalists = playRound(round8, ROUND_BONUS.sf);

    const finalists = [];
    for (let i = 0; i < semiFinalists.length; i += 2) {
      const winner = decideKnockout(rng, semiFinalists[i], semiFinalists[i + 1], ratingOf);
      const loser = winner === semiFinalists[i] ? semiFinalists[i + 1] : semiFinalists[i];
      bonus.set(loser, THIRD_PLACE_BONUS);
      finalists.push(winner);
    }

    const champion = decideKnockout(rng, finalists[0], finalists[1], ratingOf);
    const runnerUp = champion === finalists[0] ? finalists[1] : finalists[0];
    bonus.set(champion, FINAL_WINNER_BONUS);
    bonus.set(runnerUp, FINAL_RUNNER_UP_BONUS);

    teamTitleCount.set(champion, teamTitleCount.get(champion) + 1);
    const championOwner = teamOwner(champion);
    if (championOwner) winCount.set(championOwner, winCount.get(championOwner) + 1);
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

  const entrantsForecast = new Map();
  entrants.forEach((entrant) => {
    const winPct = (winCount.get(entrant.name) / iterations) * 100;
    const runnerUpPct = (runnerUpCount.get(entrant.name) / iterations) * 100;
    const spoonPct = (spoonCount.get(entrant.name) / iterations) * 100;
    const bestTeam = entrant.teams
      .map((team) => normalizeTeamName(team))
      .reduce((best, team) =>
        (teamTitleOdds.get(team) ?? 0) > (teamTitleOdds.get(best) ?? 0) ? team : best,
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
    });
  });

  return { iterations, entrants: entrantsForecast, teamTitleOdds };
}
