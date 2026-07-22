import { alphabetizeStandings, buildTeamPerformance, mapFootballDataStandings, normalizeTeamName } from "./domain.js";
import { DEFAULT_COMPETITION_CODE, competitionFor, zoneFor } from "./competitions.js";
import { registerTeams } from "./badges.js";
import { locationForMatch } from "./locations.js";

// Set this to your deployed Cloudflare Worker origin to serve live data without a
// deploy, e.g. "https://goon-squad-data.<your-subdomain>.workers.dev". Leave empty to
// use the static data/<comp>/live.json baked by the GitHub Action (refreshed every 5 min).
export const DATA_API = "https://goon-squad-data.gs-wc.workers.dev";

export async function loadModel(comp = DEFAULT_COMPETITION_CODE) {
  const [raw, scorerData] = await Promise.all([loadLiveData(comp), loadScorers(comp)]);
  return buildModel(raw, scorerData);
}

export function buildModel(raw, scorerData = {}) {
  // Pre-season the feed still serves a full table, but in an arbitrary order with
  // every row at 0 points; alphabetize it so it reads sensibly. Zone bands on that
  // are also noise (an alphabetical "European places"), so zones only apply once
  // somebody has actually played. One effective-zones computation feeds the
  // standings, the tables and the legend alike.
  const base = competitionFor(raw.competition);
  const seasonStarted = (raw.standings ?? []).some((standing) =>
    (standing.table ?? []).some((row) => (row.playedGames ?? 0) > 0),
  );
  const competition = { ...base, zones: seasonStarted ? base.zones : [] };
  const standingsPayload = seasonStarted ? raw.standings ?? [] : alphabetizeStandings(raw.standings);
  const matches = (raw.matches ?? []).map(normalizeMatch);
  const standings = mapFootballDataStandings({ standings: standingsPayload }, competition.zones);
  const hasData = matches.length > 0 || standings.size > 0;

  if (!hasData) {
    return {
      source: raw.source,
      lastUpdated: raw.lastUpdated,
      error: raw.error,
      competition,
      hasData: false,
    };
  }

  registerTeams(collectTeams(matches, standings));

  return {
    source: raw.source,
    lastUpdated: raw.lastUpdated,
    hasData: true,
    competition,
    matches,
    tables: buildLeagueTables(standingsPayload, competition, buildTeamPerformance(matches)),
    standings,
    scorers: scorerData.scorers ?? [],
  };
}

// Goal involvements are baked into a separate static file (data/<comp>/scorers.json)
// by the fetch script. It always reads from static: the Worker live path has no
// scorers endpoint. Missing or unreachable means an empty board, never a broken app.
async function loadScorers(comp) {
  try {
    const response = await fetch(`./data/${encodeURIComponent(comp)}/scorers.json?cache=${Date.now()}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } catch {
    return { scorers: [] };
  }
}

async function loadLiveData(comp) {
  if (DATA_API) {
    try {
      const response = await fetch(`${DATA_API}/${encodeURIComponent(comp)}/live`, { cache: "no-store" });
      if (response.ok) return await response.json();
    } catch {
      // Worker unreachable, fall through to the static baseline.
    }
  }
  try {
    const response = await fetch(`./data/${encodeURIComponent(comp)}/live.json?cache=${Date.now()}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } catch (error) {
    window.Sentry?.captureException?.(error);
    return {
      source: "Live data pending",
      lastUpdated: "",
      competition: comp,
      matches: [],
      standings: [],
      error: `Live data is not available yet: ${error.message}`,
    };
  }
}

function normalizeMatch(match) {
  const location = locationForMatch(match);
  return {
    id: match.id ?? null,
    utcDate: match.utcDate,
    status: match.status,
    minute: match.minute ?? null,
    stage: match.stage ?? null,
    group: match.group ?? null,
    matchday: match.matchday ?? null,
    venue: location?.venue ?? match.venue ?? null,
    city: location?.city ?? match.city ?? null,
    mapUrl: location?.mapUrl ?? match.mapUrl ?? null,
    homeTeam: normalizeTeamName(match.homeTeam),
    awayTeam: normalizeTeamName(match.awayTeam),
    homeCrest: match.homeCrest ?? null,
    awayCrest: match.awayCrest ?? null,
    homeTla: match.homeTla ?? null,
    awayTla: match.awayTla ?? null,
    score: {
      home: Number.isFinite(match.score?.home) ? match.score.home : null,
      away: Number.isFinite(match.score?.away) ? match.score.away : null,
    },
    penalties:
      Number.isFinite(match.penalties?.home) && Number.isFinite(match.penalties?.away)
        ? { home: match.penalties.home, away: match.penalties.away }
        : null,
    winner: match.winner ?? null,
  };
}

// One renderable table per standings block. A flat league (PL) yields exactly one;
// a competition with grouped tables (cups later) yields one per group. Zone bands
// come from the competition config, never from hardcoded positions. Recent form is
// computed from the matches, since the standings feed carries no form.
function buildLeagueTables(standings, competition, performance = new Map()) {
  return standings
    .filter((standing) => standing.type === "TOTAL")
    .map((standing) => ({
      name: standing.group ?? competition.name,
      rows: (standing.table ?? []).map((row, index) => {
        const position = row.position ?? index + 1;
        const team = normalizeTeamName(row.team?.shortName ?? row.team?.name);
        return {
          team,
          position,
          played: row.playedGames ?? 0,
          won: row.won ?? 0,
          drawn: row.draw ?? 0,
          lost: row.lost ?? 0,
          points: row.points ?? 0,
          goalDifference: row.goalDifference ?? 0,
          form: performance.get(team)?.form ?? [],
          zone: zoneFor(position, competition.zones),
        };
      }),
    }));
}

function collectTeams(matches, standings) {
  const teams = new Map();
  const add = (team, crest, tla) => {
    if (!team) return;
    const current = teams.get(team) ?? {};
    teams.set(team, { crest: current.crest ?? crest ?? null, tla: current.tla ?? tla ?? null });
  };
  standings.forEach((row, team) => add(team, row.crest, row.tla));
  matches.forEach((match) => {
    add(match.homeTeam, match.homeCrest, match.homeTla);
    add(match.awayTeam, match.awayCrest, match.awayTla);
  });
  return teams;
}
