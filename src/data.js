import { mapFootballDataStandings, normalizeTeamName } from "./domain.js";
import { competitionFor, zoneFor } from "./competitions.js";
import { registerCrests } from "./badges.js";
import { locationForMatch } from "./locations.js";

// Set this to your deployed Cloudflare Worker origin to serve live data without a
// deploy, e.g. "https://goon-squad-data.<your-subdomain>.workers.dev". Leave empty to
// use the static data/live.json baked by the GitHub Action (refreshed every 5 min).
export const DATA_API = "https://goon-squad-data.gs-wc.workers.dev";

export async function loadModel() {
  const [raw, scorerData] = await Promise.all([loadLiveData(), loadScorers()]);
  return buildModel(raw, scorerData);
}

export function buildModel(raw, scorerData = {}) {
  // Pre-season the feed already serves a full table, alphabetical with zero points.
  // Zone bands on that are noise (an alphabetical "European places"), so zones only
  // apply once somebody has actually played. One effective-zones computation feeds
  // the standings, the tables and the legend alike.
  const base = competitionFor(raw.competition);
  const seasonStarted = (raw.standings ?? []).some((standing) =>
    (standing.table ?? []).some((row) => (row.playedGames ?? 0) > 0),
  );
  const competition = { ...base, zones: seasonStarted ? base.zones : [] };
  const matches = (raw.matches ?? []).map(normalizeMatch);
  const standings = mapFootballDataStandings({ standings: raw.standings ?? [] }, competition.zones);
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

  registerCrests(collectCrests(matches, standings));

  return {
    source: raw.source,
    lastUpdated: raw.lastUpdated,
    hasData: true,
    competition,
    matches,
    tables: buildLeagueTables(raw.standings ?? [], competition),
    standings,
    scorers: scorerData.scorers ?? [],
  };
}

// Goal involvements are baked into a separate static file (data/scorers.json) by the
// fetch script. It always reads from static: the Worker live path has no scorers
// endpoint. Missing or unreachable means an empty board, never a broken app.
async function loadScorers() {
  try {
    const response = await fetch(`./data/scorers.json?cache=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } catch {
    return { scorers: [] };
  }
}

async function loadLiveData() {
  if (DATA_API) {
    try {
      const response = await fetch(`${DATA_API}/live`, { cache: "no-store" });
      if (response.ok) return await response.json();
    } catch {
      // Worker unreachable, fall through to the static baseline.
    }
  }
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
// come from the competition config, never from hardcoded positions.
function buildLeagueTables(standings, competition) {
  return standings
    .filter((standing) => standing.type === "TOTAL")
    .map((standing) => ({
      name: standing.group ?? competition.name,
      rows: (standing.table ?? []).map((row, index) => {
        const position = row.position ?? index + 1;
        return {
          team: normalizeTeamName(row.team?.shortName ?? row.team?.name),
          position,
          played: row.playedGames ?? 0,
          won: row.won ?? 0,
          drawn: row.draw ?? 0,
          lost: row.lost ?? 0,
          points: row.points ?? 0,
          goalDifference: row.goalDifference ?? 0,
          zone: zoneFor(position, competition.zones),
        };
      }),
    }));
}

function collectCrests(matches, standings) {
  const crests = new Map();
  standings.forEach((row, team) => {
    if (row.crest) crests.set(team, row.crest);
  });
  matches.forEach((match) => {
    if (match.homeCrest && !crests.has(match.homeTeam)) crests.set(match.homeTeam, match.homeCrest);
    if (match.awayCrest && !crests.has(match.awayTeam)) crests.set(match.awayTeam, match.awayCrest);
  });
  return crests;
}
