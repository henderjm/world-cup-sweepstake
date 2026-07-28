// Weekly recap: the numbers. Every figure the AI recap quotes is computed
// here, from real rows, and handed to the model as data. The model writes
// prose and nothing else. A power ranking a model invented would be worse than
// no power ranking at all, because it would look exactly as authoritative.
//
// Pure: arrays in, arrays out. No DOM, no fetch, no D1, same contract as
// fantasyScoring.js / fantasyGameweek.js / fantasyWaivers.js.
//
// NOTE ON PLAYER VALUE. This module deliberately defines NO notion of what a
// player is worth. That already exists once, as value over replacement in
// src/fantasyDraftRank.js (a player's projection minus the projection of the
// last player at his position who will still be free after every squad is
// filled). A second, competing definition here would mean the app showing two
// different numbers both claiming to mean "how good is this player", which is
// worse than showing one imperfect number. Everything below is instead built
// on points a manager ACTUALLY SCORED, which is a different quantity: realised
// output, not projected value.

import { standingsFromFixtures } from "./fantasyGameweek.js";

// How many gameweeks count as "recent" for the form half of a power score.
// Three is short enough to move when a manager turns a season around and long
// enough that one bad captain call does not define them.
export const RECENT_FORM_WINDOW = 3;

// Power score weights. All three terms are in fantasy-points units so the
// weights actually mean something and the resulting number is comparable to a
// typical gameweek score, rather than being an opaque index:
//
//   recent form   how they are scoring NOW, which is what a ranking is for
//   season output the whole body of work, so three good weeks cannot erase ten bad
//   record        winning matters, but scoring is the skill; H2H is noisy by design
//
// The record term is converted into points units by multiplying win rate by
// the league's own average gameweek score, so a league that scores 40 a week
// and one that scores 90 weight it the same way relative to themselves.
const WEIGHT_RECENT = 0.5;
const WEIGHT_SEASON = 0.3;
const WEIGHT_RECORD = 0.2;

export function median(values) {
  const sorted = (values ?? []).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values) {
  if (!values?.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Rounds to one decimal. Every figure that reaches the model or the UI goes
// through this: a power score printed as 63.79999999999998 would read as a
// bug, and a recap is nothing but numbers in prose.
function round1(value) {
  return Math.round(value * 10) / 10;
}

// The ranking. `managers` is [{ userId, name }], `fixtures` is the decided
// head-to-head rows ([{ gameweek, homeUserId, awayUserId, homeScore,
// awayScore }]) and `scores` is [{ userId, gameweek, points }] from
// fantasy_gameweek_scores. Both are filtered to `throughGameweek` here rather
// than by the caller, so a caller cannot accidentally rank one manager on more
// gameweeks than another.
//
// Returns one row per manager, best first, each 1-indexed with `rank`. A
// manager with no scored gameweek at all still appears (with zeroes) rather
// than vanishing from their own league's rankings.
export function buildPowerRankings({ managers, fixtures, scores, throughGameweek }) {
  const roster = managers ?? [];
  const cutoff = Number.isFinite(throughGameweek) ? throughGameweek : Infinity;

  const decided = (fixtures ?? []).filter(
    (fixture) => fixture.gameweek <= cutoff && fixture.homeScore != null && fixture.awayScore != null,
  );
  const table = new Map(standingsFromFixtures(decided, roster).map((row) => [row.userId, row]));

  const byManager = new Map(roster.map((manager) => [manager.userId, []]));
  for (const score of scores ?? []) {
    if (score.gameweek > cutoff) continue;
    const list = byManager.get(score.userId);
    if (!list) continue; // a score row for someone no longer in the league
    list.push({ gameweek: score.gameweek, points: Number(score.points) || 0 });
  }
  for (const list of byManager.values()) list.sort((a, b) => a.gameweek - b.gameweek);

  const seasonAverages = roster.map((manager) => mean((byManager.get(manager.userId) ?? []).map((s) => s.points)));
  const leagueAverage = mean(seasonAverages);

  const rows = roster.map((manager) => {
    const history = byManager.get(manager.userId) ?? [];
    const points = history.map((entry) => entry.points);
    const record = table.get(manager.userId) ?? {
      played: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      pointsFor: 0,
      pointsAgainst: 0,
      recordPoints: 0,
    };
    const seasonAvg = mean(points);
    const recentAvg = mean(points.slice(-RECENT_FORM_WINDOW));
    // A manager who has played no decided fixture has no win rate, and
    // treating that as 0% would punish them for the schedule rather than for
    // anything they did.
    const winPct = record.played ? record.recordPoints / (3 * record.played) : 0;

    return {
      userId: manager.userId,
      name: manager.name,
      played: record.played,
      wins: record.wins,
      draws: record.draws,
      losses: record.losses,
      pointsFor: round1(record.pointsFor),
      pointsAgainst: round1(record.pointsAgainst),
      recordPoints: record.recordPoints,
      seasonAvg: round1(seasonAvg),
      recentAvg: round1(recentAvg),
      winPct: Math.round(winPct * 100) / 100,
      lastGameweekPoints: points.length ? round1(points[points.length - 1]) : null,
      powerScore: round1(WEIGHT_RECENT * recentAvg + WEIGHT_SEASON * seasonAvg + WEIGHT_RECORD * winPct * leagueAverage),
    };
  });

  rows.sort(
    (a, b) =>
      b.powerScore - a.powerScore ||
      b.recordPoints - a.recordPoints ||
      b.pointsFor - a.pointsFor ||
      String(a.name).localeCompare(String(b.name)),
  );
  rows.forEach((row, index) => {
    row.rank = index + 1;
  });
  return rows;
}

// Movement since the previous week's ranking. Positive means climbed (rank 5
// to rank 2 is +3), which is the direction a reader expects an arrow to mean.
// A manager absent from `previous` gets null, not 0: "new entry" and "held
// station" are different facts and the prose should be able to tell them apart.
export function attachRankMovement(current, previous) {
  const before = new Map((previous ?? []).map((row) => [row.userId, row.rank]));
  return (current ?? []).map((row) => {
    const priorRank = before.get(row.userId);
    return { ...row, previousRank: priorRank ?? null, movement: priorRank == null ? null : priorRank - row.rank };
  });
}

// One gameweek's head-to-head results. `winnerUserId` null is a genuine draw,
// distinct from a fixture that has not been decided (those are dropped, never
// reported as 0-0).
export function matchupResults({ fixtures, gameweek }) {
  return (fixtures ?? [])
    .filter((fixture) => fixture.gameweek === gameweek && fixture.homeScore != null && fixture.awayScore != null)
    .map((fixture) => {
      const home = Number(fixture.homeScore);
      const away = Number(fixture.awayScore);
      return {
        homeUserId: fixture.homeUserId,
        awayUserId: fixture.awayUserId,
        homeScore: round1(home),
        awayScore: round1(away),
        winnerUserId: home === away ? null : home > away ? fixture.homeUserId : fixture.awayUserId,
        margin: round1(Math.abs(home - away)),
      };
    });
}

// The two or three awards. Every one of them returns null rather than a
// fabricated winner when the data cannot support it (nobody benched anyone, no
// captain was set, nobody won while below the median), because "no award this
// week" is a true statement and an invented award is not.
//
// `lineups` is [{ userId, starters: [{ playerId, isCaptain }], bench:
// [playerId] }] as the Worker's resolveManagerLineup already produces,
// `playerPoints` is a Map<playerId, points> for this gameweek, and `players`
// is a Map<playerId, { name, team }> for naming the winner.
export function gameweekAwards({ managers, lineups, playerPoints, players, results, scores }) {
  const nameFor = (userId) => (managers ?? []).find((manager) => manager.userId === userId)?.name ?? "Someone";
  const playerName = (playerId) => players?.get?.(playerId)?.name || `Player ${playerId}`;
  const pointsFor = (playerId) => Number(playerPoints?.get?.(playerId) ?? 0);

  return {
    benchKing: benchKingAward(lineups, pointsFor, playerName, nameFor),
    worstCaptain: worstCaptainAward(lineups, pointsFor, playerName, nameFor),
    luckiestWin: luckiestWinAward(results, scores, nameFor),
  };
}

// Most points left sitting on the bench. The sting of fantasy football, and
// the one award every league argues about.
function benchKingAward(lineups, pointsFor, playerName, nameFor) {
  let best = null;
  for (const lineup of lineups ?? []) {
    const bench = lineup.bench ?? [];
    if (!bench.length) continue;
    const total = bench.reduce((sum, playerId) => sum + pointsFor(playerId), 0);
    if (total <= 0) continue; // an all-blank bench is not an award, it is a Tuesday
    if (!best || total > best.points) {
      const topId = [...bench].sort((a, b) => pointsFor(b) - pointsFor(a))[0];
      best = {
        userId: lineup.userId,
        name: nameFor(lineup.userId),
        points: round1(total),
        detail: `${playerName(topId)} led the bench on ${round1(pointsFor(topId))}`,
      };
    }
  }
  return best;
}

// The captaincy that cost the most: how many points a manager gave up by
// doubling the wrong player. Measured against the best scorer in their OWN
// starting XI, not the best in the league, since only the XI was actually
// available to captain.
function worstCaptainAward(lineups, pointsFor, playerName, nameFor) {
  let worst = null;
  for (const lineup of lineups ?? []) {
    const starters = lineup.starters ?? [];
    const captain = starters.find((entry) => entry.isCaptain);
    if (!captain) continue;
    const captainPoints = pointsFor(captain.playerId);
    const bestStarter = starters.reduce(
      (best, entry) => (pointsFor(entry.playerId) > pointsFor(best.playerId) ? entry : best),
      starters[0],
    );
    // The captain's armband doubles a player, so picking the wrong one costs
    // the DIFFERENCE between the two, once (the doubling applies either way).
    const cost = pointsFor(bestStarter.playerId) - captainPoints;
    if (cost <= 0) continue; // captained the right player; nothing to award
    if (!worst || cost > worst.points) {
      worst = {
        userId: lineup.userId,
        name: nameFor(lineup.userId),
        points: round1(cost),
        detail: `captained ${playerName(captain.playerId)} on ${round1(captainPoints)} with ${playerName(bestStarter.playerId)} on ${round1(pointsFor(bestStarter.playerId))} in the same XI`,
      };
    }
  }
  return worst;
}

// Won despite scoring below the league median: the manager the schedule was
// kind to. Judged against the median rather than the mean so one enormous
// score cannot drag the bar up and make everyone else look lucky.
function luckiestWinAward(results, scores, nameFor) {
  const values = (scores ?? []).map((entry) => Number(entry.points) || 0);
  const middle = median(values);
  if (middle == null) return null;

  let luckiest = null;
  for (const result of results ?? []) {
    if (result.winnerUserId == null) continue;
    const winnerScore = result.winnerUserId === result.homeUserId ? result.homeScore : result.awayScore;
    if (winnerScore >= middle) continue;
    const shortfall = middle - winnerScore;
    if (!luckiest || shortfall > luckiest.points) {
      luckiest = {
        userId: result.winnerUserId,
        name: nameFor(result.winnerUserId),
        points: round1(shortfall),
        detail: `won with ${round1(winnerScore)}, ${round1(shortfall)} below the league median of ${round1(middle)}`,
      };
    }
  }
  return luckiest;
}
