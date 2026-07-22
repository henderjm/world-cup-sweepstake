import { locationForVenue } from "./locations.js";
import { zoneFor } from "./competitions.js";

const LIVE_STATUSES = new Set([
  "IN_PLAY",
  "PAUSED",
  "LIVE",
  "EXTRA_TIME",
  "PENALTY_SHOOTOUT",
  "BREAK",
]);

const FINISHED_STATUSES = new Set(["FINISHED", "AWARDED"]);

// Club-name aliases, applied after diacritics are stripped and case is folded.
// The feed's shortName is already the join key, so this map only needs entries
// when a source spells a club differently from the canonical short name.
const TEAM_ALIASES = new Map(
  Object.entries({
    "wolverhampton wanderers": "Wolves",
    "afc bournemouth": "Bournemouth",
    brighton: "Brighton Hove",
    "brighton and hove albion": "Brighton Hove",
    "brighton & hove albion": "Brighton Hove",
    "manchester city": "Man City",
    "manchester united": "Man United",
    "newcastle united": "Newcastle",
    "nottingham forest": "Nottingham",
    "tottenham hotspur": "Tottenham",
  }),
);

export function normalizeTeamName(name) {
  const value = String(name ?? "").trim();
  if (!value) return "Unknown";
  const key = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ");
  return TEAM_ALIASES.get(key) ?? value;
}

// Prefer the feed's shortName ("Arsenal") over the legal name ("Arsenal FC") so the
// canonical name reads naturally everywhere. Both mappers and the standings share
// this so the join key is identical across the app.
function teamName(team) {
  return normalizeTeamName(team?.shortName ?? team?.name);
}

export function buildTeamPerformance(matches) {
  const performance = new Map();

  matches.forEach((match) => {
    const home = normalizeTeamName(match.homeTeam);
    const away = normalizeTeamName(match.awayTeam);
    const homeStats = ensureStats(performance, home);
    const awayStats = ensureStats(performance, away);

    homeStats.nextMatch = pickSoonerMatch(homeStats.nextMatch, match);
    awayStats.nextMatch = pickSoonerMatch(awayStats.nextMatch, match);

    if (LIVE_STATUSES.has(match.status)) {
      homeStats.liveSummary = liveSummary(match.minute, away);
      awayStats.liveSummary = liveSummary(match.minute, home);
      homeStats.liveScore = scoreLabel(match.score);
      awayStats.liveScore = scoreLabel(reverseScore(match.score));
      return;
    }

    if (!FINISHED_STATUSES.has(match.status) || !hasScore(match.score)) {
      return;
    }

    applyFinishedMatch(homeStats, awayStats, match.score.home, match.score.away);
  });

  performance.forEach((stats) => {
    stats.goalDifference = stats.goalsFor - stats.goalsAgainst;
    stats.form = stats.form.slice(-5);
  });

  return performance;
}

export function mapFootballDataMatches(payload) {
  return (payload.matches ?? []).map((match) => {
    const raw = match.score ?? {};
    const reg = regulationScore(raw);
    const location = locationForVenue(match.venue);
    return {
      id: match.id ?? null,
      utcDate: match.utcDate,
      status: match.status,
      minute: match.minute ?? null,
      stage: match.stage ?? null,
      group: match.group ?? null,
      matchday: match.matchday ?? null,
      venue: match.venue ?? null,
      city: location?.city || null,
      mapUrl: location?.mapUrl ?? null,
      homeTeam: teamName(match.homeTeam),
      awayTeam: teamName(match.awayTeam),
      homeCrest: match.homeTeam?.crest ?? null,
      awayCrest: match.awayTeam?.crest ?? null,
      homeTla: match.homeTeam?.tla ?? null,
      awayTla: match.awayTeam?.tla ?? null,
      score: { home: reg.home, away: reg.away },
      penalties: reg.penalties,
      winner: raw.winner ?? null,
    };
  });
}

// football-data folds penalty-shootout kicks into score.fullTime, so a 1-1 game won 4-3
// on penalties arrives as fullTime 5-4. Subtract the shootout back out so `score` is the
// regulation/extra-time result (a draw) and goals aren't inflated, and expose the shootout
// separately as `penalties`. Returns { home, away, penalties: { home, away } | null }.
export function regulationScore(raw) {
  const fullHome = scoreValue(raw?.fullTime?.home ?? raw?.fullTime?.homeTeam);
  const fullAway = scoreValue(raw?.fullTime?.away ?? raw?.fullTime?.awayTeam);
  const penHome = scoreValue(raw?.penalties?.home ?? raw?.penalties?.homeTeam);
  const penAway = scoreValue(raw?.penalties?.away ?? raw?.penalties?.awayTeam);
  const hasPens = penHome !== null && penAway !== null;
  return {
    home: hasPens && fullHome !== null ? fullHome - penHome : fullHome,
    away: hasPens && fullAway !== null ? fullAway - penAway : fullAway,
    penalties: hasPens ? { home: penHome, away: penAway } : null,
  };
}

// Pre-season, football-data still serves a full table but in an arbitrary (not
// alphabetical) order with every row at 0 points, so `position` is meaningless. Sort
// those blocks by team name and renumber, so the table reads sensibly until real
// results give it a meaningful order.
export function alphabetizeStandings(standings) {
  return (standings ?? []).map((standing) => ({
    ...standing,
    table: [...(standing.table ?? [])]
      .sort((a, b) => teamName(a.team).localeCompare(teamName(b.team)))
      .map((row, index) => ({ ...row, position: index + 1 })),
  }));
}

// Standings keyed by team. `zones` comes from the competition config and stamps each
// row with the coloured band it sits in (European places, relegation, ...), or null
// for the neutral middle of the table.
export function mapFootballDataStandings(payload, zones = []) {
  const rows = new Map();

  (payload.standings ?? [])
    .filter((standing) => standing.type === "TOTAL")
    .forEach((standing) => {
      (standing.table ?? []).forEach((row) => {
        const team = teamName(row.team);
        rows.set(team, {
          team,
          group: standing.group ?? null,
          position: row.position,
          points: row.points ?? 0,
          played: row.playedGames ?? 0,
          won: row.won ?? 0,
          drawn: row.draw ?? 0,
          lost: row.lost ?? 0,
          goalsFor: row.goalsFor ?? 0,
          goalsAgainst: row.goalsAgainst ?? 0,
          goalDifference: row.goalDifference ?? 0,
          crest: row.team?.crest ?? null,
          tla: row.team?.tla ?? null,
          zone: zoneFor(row.position, zones),
        });
      });
    });

  return rows;
}

export function mergeStandingsIntoPerformance(performance, standings) {
  const merged = new Map(performance);
  standings.forEach((standing, team) => {
    merged.set(team, {
      ...blankPerformance(team),
      ...(merged.get(team) ?? {}),
      ...standing,
    });
  });
  return merged;
}

export function formatStage(stage) {
  if (!stage) return "";
  return String(stage)
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function ensureStats(performance, team) {
  if (!performance.has(team)) {
    performance.set(team, blankPerformance(team));
  }
  return performance.get(team);
}

function blankPerformance(team) {
  return {
    team: normalizeTeamName(team),
    played: 0,
    won: 0,
    drawn: 0,
    lost: 0,
    points: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    goalDifference: 0,
    form: [],
    liveSummary: "",
    liveScore: "",
    nextMatch: null,
    position: null,
    zone: null,
  };
}

function applyFinishedMatch(homeStats, awayStats, homeGoals, awayGoals) {
  homeStats.played += 1;
  awayStats.played += 1;
  homeStats.goalsFor += homeGoals;
  homeStats.goalsAgainst += awayGoals;
  awayStats.goalsFor += awayGoals;
  awayStats.goalsAgainst += homeGoals;

  if (homeGoals > awayGoals) {
    homeStats.won += 1;
    homeStats.points += 3;
    homeStats.form.push("W");
    awayStats.lost += 1;
    awayStats.form.push("L");
    return;
  }

  if (awayGoals > homeGoals) {
    awayStats.won += 1;
    awayStats.points += 3;
    awayStats.form.push("W");
    homeStats.lost += 1;
    homeStats.form.push("L");
    return;
  }

  homeStats.drawn += 1;
  awayStats.drawn += 1;
  homeStats.points += 1;
  awayStats.points += 1;
  homeStats.form.push("D");
  awayStats.form.push("D");
}

function compareMatchDate(a, b) {
  return new Date(a.utcDate).getTime() - new Date(b.utcDate).getTime();
}

function pickSoonerMatch(current, match) {
  if (FINISHED_STATUSES.has(match.status)) return current;
  if (!current) return match;
  return compareMatchDate(match, current) < 0 ? match : current;
}

function liveSummary(minute, opponent) {
  return minute ? `${minute}' vs ${opponent}` : `Live vs ${opponent}`;
}

function hasScore(score) {
  return Number.isFinite(score?.home) && Number.isFinite(score?.away);
}

function scoreValue(value) {
  return Number.isFinite(value) ? value : null;
}

function scoreLabel(score) {
  if (!hasScore(score)) return "";
  return `${score.home}-${score.away}`;
}

function reverseScore(score) {
  return hasScore(score) ? { home: score.away, away: score.home } : score;
}
