import { locationForVenue } from "./locations.js";

const LIVE_STATUSES = new Set([
  "IN_PLAY",
  "PAUSED",
  "LIVE",
  "EXTRA_TIME",
  "PENALTY_SHOOTOUT",
  "BREAK",
]);

const FINISHED_STATUSES = new Set(["FINISHED", "AWARDED"]);

export const STAGE_BONUSES = {
  GROUP_STAGE: 0,
  LAST_32: 15,
  ROUND_OF_32: 15,
  LAST_16: 25,
  ROUND_OF_16: 25,
  QUARTER_FINALS: 40,
  SEMI_FINALS: 60,
  THIRD_PLACE: 70,
  FINAL_RUNNER_UP: 85,
  FINAL_WINNER: 120,
};

const TEAM_ALIASES = new Map(
  Object.entries({
    "bosnia and herzegovina": "Bosnia",
    "bosnia-herzegovina": "Bosnia",
    "cote d'ivoire": "Ivory Coast",
    "cote divoire": "Ivory Coast",
    "cote d’ivoire": "Ivory Coast",
    "côte d’ivoire": "Ivory Coast",
    "côte d'ivoire": "Ivory Coast",
    "cabo verde": "Cape Verde",
    "cape verde islands": "Cape Verde",
    "czech republic": "Czech",
    czechia: "Czech",
    "democratic republic of the congo": "DRC",
    "dr congo": "DRC",
    "congo dr": "DRC",
    "korea republic": "South Korea",
    saudi: "Saudi Arabia",
    "saudi arabia": "Saudi Arabia",
    turkiye: "Turkey",
    "türkiye": "Turkey",
    "united states": "USA",
    "united states of america": "USA",
    "u.s.a.": "USA",
    curacao: "Curacao",
    "curaçao": "Curacao",
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

export function calculatePayouts({ entrantCount, stake, splits }) {
  const pot = roundMoney(Number(entrantCount) * Number(stake));
  const second = roundMoney(Number(splits.second));
  const woodenSpoon = roundMoney(Number(splits.woodenSpoon));
  const first = roundMoney(pot - second - woodenSpoon);

  return {
    pot,
    first,
    second,
    woodenSpoon,
  };
}

export function buildLeaderboard(entrants, performance) {
  const performanceIndex = indexPerformance(performance);
  const ranked = entrants
    .map((entrant) => {
      const teams = entrant.teams.map((team) => {
        const teamPerformance = performanceIndex.get(normalizeTeamName(team)) ?? blankPerformance(team);
        return {
          name: normalizeTeamName(team),
          ...teamPerformance,
        };
      });
      const totals = teams.reduce(
        (acc, team) => ({
          score: acc.score + team.score,
          points: acc.points + team.points,
          goalDifference: acc.goalDifference + team.goalDifference,
          goalsFor: acc.goalsFor + team.goalsFor,
          played: acc.played + team.played,
          dangerCount: acc.dangerCount + (team.dangerLevel === "out" || team.dangerLevel === "danger" ? 1 : 0),
        }),
        { score: 0, points: 0, goalDifference: 0, goalsFor: 0, played: 0, dangerCount: 0 },
      );

      return {
        ...entrant,
        teams,
        ...totals,
      };
    })
    .sort(compareEntrants);

  return ranked.map((entrant, index) => ({
    ...entrant,
    rank: index + 1,
    isCurrentBottom: index === ranked.length - 1,
  }));
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
    applyStageBonus(homeStats, awayStats, match);
  });

  performance.forEach((stats) => {
    stats.goalDifference = stats.goalsFor - stats.goalsAgainst;
    stats.score = calculateTeamScore(stats);
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
      stage: match.stage ?? "GROUP_STAGE",
      group: match.group ?? null,
      venue: match.venue ?? null,
      city: location?.city || null,
      mapUrl: location?.mapUrl ?? null,
      homeTeam: normalizeTeamName(match.homeTeam?.name ?? match.homeTeam?.shortName),
      awayTeam: normalizeTeamName(match.awayTeam?.name ?? match.awayTeam?.shortName),
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

export function mapFootballDataStandings(payload) {
  const danger = new Map();

  (payload.standings ?? [])
    .filter((standing) => standing.type === "TOTAL")
    .forEach((standing) => {
      const groupName = standing.group ?? "Group";
      (standing.table ?? []).forEach((row) => {
        const team = normalizeTeamName(row.team?.name ?? row.team?.shortName);
        danger.set(team, {
          team,
          group: groupName,
          position: row.position,
          points: row.points ?? 0,
          goalDifference: row.goalDifference ?? 0,
          played: row.playedGames ?? 0,
          dangerLevel: dangerLevel(row.position),
          dangerLabel: dangerLabel(row.position),
        });
      });
    });

  return danger;
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

export function compareEntrants(a, b) {
  return (
    b.score - a.score ||
    a.dangerCount - b.dangerCount ||
    b.points - a.points ||
    b.goalDifference - a.goalDifference ||
    b.goalsFor - a.goalsFor ||
    a.name.localeCompare(b.name)
  );
}

export function formatStage(stage) {
  return String(stage ?? "GROUP_STAGE")
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
    stageBonus: 0,
    score: 0,
    form: [],
    liveSummary: "",
    liveScore: "",
    nextMatch: null,
    group: "",
    position: null,
    dangerLevel: "unknown",
    dangerLabel: "",
  };
}

function indexPerformance(performance) {
  const index = new Map();
  performance.forEach((stats, team) => {
    index.set(normalizeTeamName(team), {
      ...blankPerformance(team),
      ...stats,
      team: normalizeTeamName(team),
    });
  });
  return index;
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

function applyStageBonus(homeStats, awayStats, match) {
  const stage = match.stage ?? "GROUP_STAGE";
  if (stage === "FINAL" && hasScore(match.score)) {
    const homeWon = match.score.home > match.score.away;
    homeStats.stageBonus = Math.max(
      homeStats.stageBonus,
      STAGE_BONUSES[homeWon ? "FINAL_WINNER" : "FINAL_RUNNER_UP"],
    );
    awayStats.stageBonus = Math.max(
      awayStats.stageBonus,
      STAGE_BONUSES[homeWon ? "FINAL_RUNNER_UP" : "FINAL_WINNER"],
    );
    return;
  }

  const bonus = STAGE_BONUSES[stage] ?? 0;
  homeStats.stageBonus = Math.max(homeStats.stageBonus, bonus);
  awayStats.stageBonus = Math.max(awayStats.stageBonus, bonus);
}

function calculateTeamScore(stats) {
  return stats.points * 10 + stats.goalDifference * 2 + stats.goalsFor + stats.stageBonus;
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

function dangerLevel(position) {
  if (!Number.isFinite(position)) return "unknown";
  if (position <= 2) return "safe";
  if (position === 3) return "danger";
  return "out";
}

function dangerLabel(position) {
  if (!Number.isFinite(position)) return "No group table yet";
  if (position <= 2) return `Group position ${position}`;
  if (position === 3) return "On the edge";
  return "Going out";
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
