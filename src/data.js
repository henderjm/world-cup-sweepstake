import {
  alphabetizeStandings,
  buildTeamPerformance,
  canonicalizeStandingsOrder,
  mapStandings,
  normalizeTeamName,
} from "./domain.js";
import { DEFAULT_COMPETITION_CODE, competitionFor, zoneFor } from "./competitions.js";
import { registerTeams } from "./badges.js";
import { locationForMatch } from "./locations.js";
import { trackException } from "./telemetry.js";
import { withLiveTable } from "./liveTable.js";
import { isLive } from "./format.js";
import { localDateKey } from "./scoreDates.js";
import { retainNewestScores } from "./scoreSnapshot.js";
import { createStandingsRecovery } from "./standingsRecovery.js";

// Set this to your deployed Cloudflare Worker origin to serve live data without a
// deploy, e.g. "https://goon-squad-data.<your-subdomain>.workers.dev". Leave empty to
// use the static data/<comp>/live.json baked by the hourly GitHub Action fallback.
// Dev builds only: a "gs-data-api" localStorage entry redirects the app at a local
// `wrangler dev` Worker (http://localhost:8787) so accounts, banter and the fantasy
// draft room can be exercised end to end without touching production. Vite strips
// the whole branch from production builds via import.meta.env.DEV.
// Deliberately still the workers.dev origin, not an api.kickoffdraft.com custom
// domain: that custom domain does not exist yet. Switch this once it does, not
// before, or the kickoffdraft.com deploy loses its backend the moment it goes live.
export const DATA_API = (import.meta.env?.DEV && devApiOverride()) || "https://goon-squad-data.gs-wc.workers.dev";

function devApiOverride() {
  try {
    return window.localStorage.getItem("gs-data-api");
  } catch {
    return null;
  }
}

const recoverStandings = createStandingsRecovery(async comp => {
  const response = await fetch(`./data/${encodeURIComponent(comp)}/live.json?cache=${Date.now()}`, {
    cache: "no-store", signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error("Standings fallback unavailable");
  return response.json();
});

export async function loadModel(comp = DEFAULT_COMPETITION_CODE) {
  const [raw, scorerData] = await Promise.all([loadLiveData(comp), loadScorers(comp)]);
  return buildModel(await recoverStandings(retainNewestScores(raw, comp), comp), scorerData);
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
  const standingsPayload = seasonStarted
    ? base.code === "CL"
      ? (raw.standings ?? []).map(standing => ({
        ...standing, table: [...(standing.table ?? [])].sort((a, b) => a.position - b.position),
      }))
      : canonicalizeStandingsOrder(raw.standings)
    : alphabetizeStandings(raw.standings);
  const matches = (raw.matches ?? []).map(normalizeMatch);
  const standings = mapStandings({ standings: standingsPayload }, competition.zones);
  const hasData = matches.length > 0 || standings.size > 0;

  if (!hasData) {
    return {
      source: raw.source,
      lastUpdated: raw.lastUpdated,
      error: raw.error,
      competition,
      hasData: false,
      ...staleness(raw),
    };
  }

  registerTeams(collectTeams(matches, standings));

  // The provider recomputes standings at FULL TIME, so the table sat still all
  // afternoon while matches were being played. Live results are folded in here,
  // once, so every table consumer sees the same figures; `tablesLive` lets the
  // view say so rather than showing numbers that quietly disagree with the
  // provider's own. See src/liveTable.js.
  // Qualifying and knockout fixtures cannot reconcile league-phase played counts.
  const tableMatches = base.standingsStages
    ? matches.filter((match) => base.standingsStages.includes(match.stage))
    : matches;
  const baseTables = buildLeagueTables(standingsPayload, competition, raw.standingsDelayed ? new Map() : buildTeamPerformance(tableMatches));
  const { tables, live: tablesLive } = raw.standingsDelayed ? { tables: baseTables, live: false } : withLiveTable({
    tables: baseTables,
    matches: tableMatches,
    zones: competition.zones,
    competitionCode: competition.code,
  });

  return {
    source: raw.source,
    lastUpdated: raw.lastUpdated,
    hasData: true,
    ...staleness(raw),
    tablesLive,
    standingsDelayed: Boolean(raw.standingsDelayed),
    standingsUpdatedAt: raw.standingsUpdatedAt ?? null,
    standingsUnavailable: Boolean(raw.standingsUnavailable),
    scorersUnavailable: Boolean(scorerData.unavailable),
    competition,
    matches,
    tables,
    standings,
    scorers: scorerData.scorers ?? [],
  };
}

// Both delivery paths mark fallback data; an unknown age must stay unknown.
function staleness(raw) {
  if (!raw?.stale) {
    const age = Date.now() - Date.parse(raw.lastUpdated);
    if ((raw.matches ?? []).some(match => isLive(match.status)) && age > 120000) {
      return { stale: true, staleAgeMs: age };
    }
    return { stale: false, staleAgeMs: null };
  }
  return { stale: true, staleAgeMs: Number.isFinite(raw.staleAgeMs) ? raw.staleAgeMs : null };
}

export function modelSignature(model) {
  // Fetch timestamps change on every poll; only visible content should repaint.
  return JSON.stringify([
    model.competition, model.hasData, model.source, model.error, model.stale, model.loading,
    model.matches, model.tables, model.scorers, model.scorersUnavailable, model.standingsDelayed, model.standingsUpdatedAt, model.standingsUnavailable, localDateKey(),
  ]);
}

// Goal involvements are baked into a separate static file (data/<comp>/scorers.json)
// by the fetch script. Keep this supplementary file's wait short because scores
// and stats share a model load; a stalled CDN must not hold fresh scores for 8s.
async function loadScorers(comp) {
  try {
    const response = await fetch(`./data/${encodeURIComponent(comp)}/scorers.json?cache=${Date.now()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const data = await response.json();
    if (!Array.isArray(data?.scorers) || !data.scorers.every(row => row
      && typeof row.player === "string" && typeof row.team === "string"
      && [row.goals, row.assists, row.points].every(Number.isFinite))) throw new Error("Invalid player statistics");
    return data;
  } catch {
    return { scorers: [], unavailable: true };
  }
}

async function loadLiveData(comp) {
  if (DATA_API) {
    try {
      const response = await fetch(`${DATA_API}/${encodeURIComponent(comp)}/live`, {
        cache: "no-store", signal: AbortSignal.timeout(8000),
      });
      if (response.ok) return await response.json();
    } catch {
      // Worker unreachable, fall through to the static baseline.
    }
  }
  try {
    const response = await fetch(`./data/${encodeURIComponent(comp)}/live.json?cache=${Date.now()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const raw = await response.json();
    const updatedAt = Date.parse(raw.lastUpdated);
    return {
      ...raw,
      stale: true,
      staleAgeMs: Number.isFinite(updatedAt) ? Math.max(0, Date.now() - updatedAt) : null,
    };
  } catch (error) {
    trackException(error);
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
    providerStatus: match.providerStatus ?? null,
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
          // Carried so the live table can apply the real third tiebreak (points,
          // then goal difference, then goals scored) rather than stopping at GD.
          goalsFor: row.goalsFor ?? 0,
          awayGoals: row.awayGoals ?? null,
          awayWins: row.awayWins ?? null,
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
