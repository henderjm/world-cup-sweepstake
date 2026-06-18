import {
  buildLeaderboard,
  buildTeamPerformance,
  calculatePayouts,
  mapFootballDataStandings,
  mergeStandingsIntoPerformance,
  normalizeTeamName,
} from "./domain.js";
import { isFinished, isLive } from "./format.js";
import { runForecast } from "./forecast.js";

export const ENTRANTS = [
  { name: "Ois", teams: ["Tunisia", "Sweden", "Colombia"] },
  { name: "Mark", teams: ["Bosnia", "Ecuador", "Spain"] },
  { name: "Sinead", teams: ["New Zealand", "Algeria", "Belgium"] },
  { name: "Chris", teams: ["South Africa", "Switzerland", "Portugal"] },
  { name: "Dockrell", teams: ["Haiti", "Australia", "Croatia"] },
  { name: "Les", teams: ["Cape Verde", "South Korea", "Mexico"] },
  { name: "Eoin", teams: ["Curacao", "Paraguay", "Senegal"] },
  { name: "Cal", teams: ["Ghana", "Canada", "Brazil"] },
  { name: "Sarah", teams: ["Scotland", "Ivory Coast", "Uruguay"] },
  { name: "Carys", teams: ["DRC", "Japan", "Netherlands"] },
  { name: "Al", teams: ["Uzbekistan", "Panama", "England"] },
  { name: "Rachel", teams: ["Qatar", "Egypt", "Germany"] },
  { name: "April", teams: ["Czech", "Iran", "Morocco"] },
  { name: "Jean", teams: ["Jordan", "Norway", "Argentina"] },
  { name: "Joe", teams: ["Saudi Arabia", "Austria", "France"] },
  { name: "Dymps", teams: ["Iraq", "Turkey", "USA"] },
];

const PAYOUTS = { entrantCount: 16, stake: 10, splits: { second: 30, woodenSpoon: 30 } };

export const OWNER_BY_TEAM = new Map(
  ENTRANTS.flatMap((entrant) => entrant.teams.map((team) => [normalizeTeamName(team), entrant.name])),
);

export function ownerOf(team) {
  return OWNER_BY_TEAM.get(normalizeTeamName(team)) ?? null;
}

export async function loadModel() {
  return buildModel(await loadLiveData());
}

export function buildModel(raw) {
  const matches = (raw.matches ?? []).map(normalizeMatch);
  const groups = buildGroups(raw.standings ?? []);
  const standings = mapFootballDataStandings({ standings: raw.standings ?? [] });
  const hasData = matches.length > 0 || standings.size > 0;

  if (!hasData) {
    return { source: raw.source, lastUpdated: raw.lastUpdated, error: raw.error, hasData: false };
  }

  const performance = mergeStandingsIntoPerformance(buildTeamPerformance(matches), standings);
  const leaderboard = buildLeaderboard(ENTRANTS, performance);
  const payouts = calculatePayouts(PAYOUTS);
  const prizes = currentPrizes(matches);
  const spoon = woodenSpoon(matches);
  const groupTables = buildGroupTables(raw.standings ?? []);
  const momentum = buildMomentum(matches);

  const forecast = runForecast({
    groups,
    groupMatches: matches.filter((match) => match.stage === "GROUP_STAGE"),
    ownerByTeam: OWNER_BY_TEAM,
    entrants: ENTRANTS,
    seed: seedFrom(raw.lastUpdated),
    iterations: 5000,
  });

  return {
    source: raw.source,
    lastUpdated: raw.lastUpdated,
    hasData: true,
    matches,
    groups,
    groupTables,
    leaderboard,
    payouts,
    prizes,
    spoon,
    momentum,
    forecast,
  };
}

async function loadLiveData() {
  try {
    const response = await fetch(`./data/live.json?cache=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } catch (error) {
    window.Sentry?.captureException?.(error);
    return {
      source: "Live data pending",
      lastUpdated: "",
      matches: [],
      standings: [],
      error: `Live data is not available yet: ${error.message}`,
    };
  }
}

function normalizeMatch(match) {
  return {
    utcDate: match.utcDate,
    status: match.status,
    minute: match.minute ?? null,
    stage: match.stage ?? "GROUP_STAGE",
    group: match.group ?? null,
    homeTeam: normalizeTeamName(match.homeTeam),
    awayTeam: normalizeTeamName(match.awayTeam),
    score: {
      home: Number.isFinite(match.score?.home) ? match.score.home : null,
      away: Number.isFinite(match.score?.away) ? match.score.away : null,
    },
  };
}

function buildGroups(standings) {
  return standings
    .filter((standing) => standing.type === "TOTAL")
    .map((standing) => ({
      name: standing.group ?? "Group",
      teams: (standing.table ?? []).map((row) =>
        normalizeTeamName(row.team?.name ?? row.team?.shortName),
      ),
    }));
}

function buildGroupTables(standings) {
  return standings
    .filter((standing) => standing.type === "TOTAL")
    .map((standing) => ({
      name: standing.group ?? "Group",
      rows: (standing.table ?? []).map((row, index) => {
        const position = row.position ?? index + 1;
        return {
          team: normalizeTeamName(row.team?.name ?? row.team?.shortName),
          position,
          played: row.playedGames ?? 0,
          points: row.points ?? 0,
          goalDifference: row.goalDifference ?? 0,
          dangerLevel: position <= 2 ? "safe" : position === 3 ? "edge" : "out",
        };
      }),
    }));
}

function buildMomentum(matches) {
  const momentum = new Map(ENTRANTS.map((entrant) => [entrant.name, 0]));
  const now = Date.now();
  const recentWindow = 48 * 60 * 60 * 1000;

  matches.forEach((match) => {
    const { home, away } = matchEffect(match, now, recentWindow);
    bump(momentum, match.homeTeam, home);
    bump(momentum, match.awayTeam, away);
  });
  return momentum;
}

function matchEffect(match, now, recentWindow) {
  const homeScore = match.score?.home;
  const awayScore = match.score?.away;
  const decided = Number.isFinite(homeScore) && Number.isFinite(awayScore);

  if (isLive(match.status) && decided) {
    return { home: Math.sign(homeScore - awayScore), away: Math.sign(awayScore - homeScore) };
  }
  if (isFinished(match.status) && decided) {
    const kickOff = new Date(match.utcDate).getTime();
    if (now - kickOff > recentWindow) return { home: 0, away: 0 };
    return { home: Math.sign(homeScore - awayScore), away: Math.sign(awayScore - homeScore) };
  }
  return { home: 0, away: 0 };
}

function bump(momentum, team, delta) {
  const owner = ownerOf(team);
  if (owner && delta) momentum.set(owner, momentum.get(owner) + delta);
}

// Current confirmed prizes, driven by the final result (not the points table).
function currentPrizes(matches) {
  const final = matches.find((match) => match.stage === "FINAL" && isDecided(match));
  if (!final) {
    return { champion: recipient(), runnerUp: recipient() };
  }
  const championTeam = matchWinner(final);
  const runnerUpTeam =
    championTeam === final.homeTeam ? final.awayTeam : final.homeTeam;
  return { champion: recipient(championTeam), runnerUp: recipient(runnerUpTeam) };
}

function recipient(team = "") {
  const normalized = team ? normalizeTeamName(team) : "";
  return { team: normalized, owner: normalized ? ownerOf(normalized) ?? "Unowned" : "TBC" };
}

function woodenSpoon(matches) {
  const performance = buildTeamPerformance(matches);

  const confirmed = ENTRANTS.flatMap((entrant) =>
    entrant.teams.map((team) => {
      const name = normalizeTeamName(team);
      return { owner: entrant.name, team: name, stats: performance.get(name) };
    }),
  )
    .filter(({ team }) => isConfirmedGroupLast(team, matches))
    .sort((a, b) => spoonScore(a.stats) - spoonScore(b.stats));

  if (!confirmed.length) {
    return { owner: "TBC", team: null, status: "Waiting on a confirmed group-stage last place" };
  }
  return { owner: confirmed[0].owner, team: confirmed[0].team, status: "Confirmed out in the group" };
}

function spoonScore(stats) {
  if (!stats) return Infinity;
  return stats.points * 100 + stats.goalDifference * 10 + stats.goalsFor;
}

function isConfirmedGroupLast(team, matches) {
  const teamMatches = matches.filter(
    (match) =>
      match.stage === "GROUP_STAGE" && [match.homeTeam, match.awayTeam].includes(team),
  );
  if (teamMatches.length < 3 || !teamMatches.every((match) => isFinished(match.status))) {
    return false;
  }
  const group = teamMatches[0].group;
  const groupTeams = new Map();
  matches
    .filter((match) => match.stage === "GROUP_STAGE" && match.group === group)
    .forEach((match) => {
      if (!Number.isFinite(match.score?.home) || !Number.isFinite(match.score?.away)) return;
      tally(groupTeams, match.homeTeam, match.score.home, match.score.away);
      tally(groupTeams, match.awayTeam, match.score.away, match.score.home);
    });
  const standing = [...groupTeams.values()].sort(
    (a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf,
  );
  return standing.length > 0 && standing[standing.length - 1].team === team;
}

function tally(map, team, scored, conceded) {
  if (!map.has(team)) map.set(team, { team, points: 0, gd: 0, gf: 0 });
  const record = map.get(team);
  record.gf += scored;
  record.gd += scored - conceded;
  if (scored > conceded) record.points += 3;
  else if (scored === conceded) record.points += 1;
}

function isDecided(match) {
  return isFinished(match.status) && Boolean(matchWinner(match));
}

function matchWinner(match) {
  if (Number.isFinite(match.score?.home) && Number.isFinite(match.score?.away)) {
    if (match.score.home > match.score.away) return match.homeTeam;
    if (match.score.away > match.score.home) return match.awayTeam;
  }
  return "";
}

function seedFrom(value) {
  const text = String(value ?? "seed");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
