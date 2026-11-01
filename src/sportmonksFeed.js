// Sportmonks as a FULL source for the competitions it serves on its own
// (Serie A and La Liga), mapped into exactly the shapes the API-Football path
// produces: the live feed's raw `{ matches, standings }` for buildModel, and
// the match detail the drawer and the V2 Match page read. Pure; the Worker
// does the fetching (worker/sportmonksLive.js). Keep any new translation here,
// so the two providers can never disagree about what a field means.
//
// Match ids are OFFSET (SPORTMONKS_ID_OFFSET + the Sportmonks id). Comments,
// predictions, follows and the match page key on a bare integer, and the two
// providers number fixtures independently, so an unshifted id could one day
// collide with an API-Football fixture and show one match's comments on
// another's page.

import { normalizeTeamName } from "./domain.js";

export const SPORTMONKS_ID_OFFSET = 1_000_000_000;

export function appMatchId(sportmonksId) {
  return SPORTMONKS_ID_OFFSET + Number(sportmonksId);
}

// The Sportmonks fixture id behind an app match id, or null for an
// API-Football id.
export function sportmonksIdOf(appId) {
  const id = Number(appId);
  return Number.isFinite(id) && id >= SPORTMONKS_ID_OFFSET ? id - SPORTMONKS_ID_OFFSET : null;
}

// Sportmonks state -> [app status, providerStatus]. The providerStatus uses
// API-Football's short codes where the app already labels them (HT, SUSP,
// INT) so statusLabel needs no second vocabulary. AWAITING_UPDATES is a match
// the provider has lost track of mid-game: "Paused" rather than a guess at
// either "not started" or "finished", both of which would state a falsehood.
const STATES = {
  NS: ["TIMED", "NS"], TBA: ["TIMED", "TBD"], PENDING: ["TIMED", "NS"], DELAYED: ["TIMED", "NS"],
  INPLAY_1ST_HALF: ["IN_PLAY", "1H"], INPLAY_2ND_HALF: ["IN_PLAY", "2H"],
  HT: ["PAUSED", "HT"], BREAK: ["BREAK", "BT"], EXTRA_TIME_BREAK: ["BREAK", "BT"],
  INPLAY_ET: ["EXTRA_TIME", "ET"], INPLAY_ET_SECOND_HALF: ["EXTRA_TIME", "ET"],
  PEN_BREAK: ["PENALTY_SHOOTOUT", "P"], INPLAY_PENALTIES: ["PENALTY_SHOOTOUT", "P"],
  FT: ["FINISHED", "FT"], AET: ["FINISHED", "AET"], FT_PEN: ["FINISHED", "PEN"],
  POSTPONED: ["POSTPONED", "PST"], CANCELLED: ["CANCELLED", "CANC"], ABANDONED: ["CANCELLED", "ABD"], DELETED: ["CANCELLED", "CANC"],
  SUSPENDED: ["PAUSED", "SUSP"], INTERRUPTED: ["PAUSED", "INT"], AWAITING_UPDATES: ["PAUSED", "INT"],
  AWARDED: ["AWARDED", "AWD"], WO: ["AWARDED", "WO"],
};

const LIVE = new Set(["IN_PLAY", "PAUSED", "BREAK", "EXTRA_TIME", "PENALTY_SHOOTOUT"]);

// "2026-10-31 14:00:00" (UTC, no zone) -> ISO.
export function sportmonksInstant(value) {
  if (!value) return null;
  const iso = `${String(value).replace(" ", "T")}${/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? "" : "Z"}`;
  return Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString().replace(".000Z", "Z") : null;
}

function participant(fixture, side) {
  return fixture.participants?.find(team => team.meta?.location === side) ?? null;
}

function scoreOf(fixture, description) {
  const rows = (fixture.scores ?? []).filter(row => row.description === description);
  const goals = side => rows.find(row => row.score?.participant === side)?.score?.goals;
  const home = goals("home");
  const away = goals("away");
  return Number.isFinite(home) && Number.isFinite(away) ? { home, away } : null;
}

function stateOf(fixture) {
  return STATES[fixture.state?.developer_name] ?? ["TIMED", fixture.state?.developer_name ?? null];
}

function liveMinute(fixture, status) {
  if (!LIVE.has(status)) return null;
  const period = (fixture.periods ?? []).find(entry => entry.ticking) ?? null;
  return Number.isFinite(period?.minutes) ? period.minutes : null;
}

function matchday(fixture) {
  const round = Number(fixture.round?.name);
  return Number.isInteger(round) ? round : null;
}

// One fixture as an app match summary (the shape mapApiFootballMatches gives).
export function mapSportmonksMatch(fixture) {
  const [status, providerStatus] = stateOf(fixture);
  const home = participant(fixture, "home");
  const away = participant(fixture, "away");
  const decided = status === "FINISHED" || status === "AWARDED" || LIVE.has(status);
  const score = decided ? scoreOf(fixture, "CURRENT") : null;
  const penalties = scoreOf(fixture, "PENALTY_SHOOTOUT");
  const winner = home?.meta?.winner ? "HOME_TEAM" : away?.meta?.winner ? "AWAY_TEAM"
    : status === "FINISHED" && score && score.home === score.away ? "DRAW" : null;
  return {
    id: appMatchId(fixture.id),
    utcDate: sportmonksInstant(fixture.starting_at),
    status,
    providerStatus,
    minute: liveMinute(fixture, status),
    stage: "REGULAR_SEASON",
    group: null,
    matchday: matchday(fixture),
    venue: fixture.venue?.name ?? null,
    city: fixture.venue?.city_name ?? null,
    mapUrl: null,
    homeTeam: normalizeTeamName(home?.name),
    awayTeam: normalizeTeamName(away?.name),
    homeCrest: home?.image_path ?? null,
    awayCrest: away?.image_path ?? null,
    homeTla: home?.short_code ?? null,
    awayTla: away?.short_code ?? null,
    score: { home: score?.home ?? null, away: score?.away ?? null },
    penalties: penalties && decided ? penalties : null,
    winner,
  };
}

// Standing detail type ids (verified on Serie A 2026/27).
const STANDING = { played: 129, won: 130, drawn: 131, lost: 132, scored: 133, conceded: 134, gd: 179 };

// Season standings in the raw football-data shape buildModel reads.
export function mapSportmonksStandings(rows) {
  const detail = (row, key) => {
    const value = Number(row.details?.find(entry => entry.type_id === STANDING[key])?.value);
    return Number.isFinite(value) ? value : 0;
  };
  const table = [...(rows ?? [])]
    .sort((a, b) => a.position - b.position)
    .map(row => ({
      position: row.position,
      team: {
        name: row.participant?.name ?? null,
        shortName: row.participant?.name ?? null,
        crest: row.participant?.image_path ?? null,
        tla: row.participant?.short_code ?? null,
      },
      playedGames: detail(row, "played"),
      won: detail(row, "won"),
      draw: detail(row, "drawn"),
      lost: detail(row, "lost"),
      points: Number(row.points) || 0,
      goalsFor: detail(row, "scored"),
      goalsAgainst: detail(row, "conceded"),
      goalDifference: detail(row, "gd"),
    }));
  return table.length ? [{ type: "TOTAL", stage: "REGULAR_SEASON", group: null, table }] : [];
}

// The live feed body for one competition, the shape getLive returns.
export function mapSportmonksFeed({ competition, season, fixtures, standings, lastUpdated }) {
  const seen = new Map();
  for (const fixture of fixtures ?? []) seen.set(fixture.id, fixture);
  return {
    source: "Sportmonks",
    lastUpdated,
    competition,
    season,
    matches: [...seen.values()].map(mapSportmonksMatch).sort((a, b) => String(a.utcDate).localeCompare(String(b.utcDate))),
    standings: mapSportmonksStandings(standings),
  };
}

// Event and position type ids (verified on Serie A 2026/27).
const EVENT = { goal: 14, ownGoal: 15, penalty: 16, sub: 18, yellow: 19, red: 20, yellowRed: 21 };
const POSITION = { 24: "G", 25: "D", 26: "M", 27: "F" };
const RATING = 118;
const MINUTES = 119;

function lineupDetail(entry, typeId) {
  const value = Number(entry.details?.find(detail => detail.type_id === typeId)?.data?.value);
  return Number.isFinite(value) ? value : null;
}

// Full match detail in the shape buildMatchDetail (mapApiFootball.js) gives.
export function mapSportmonksDetail(fixture) {
  const summary = mapSportmonksMatch(fixture);
  const home = participant(fixture, "home");
  const away = participant(fixture, "away");
  const teamName = new Map((fixture.participants ?? []).map(team => [team.id, normalizeTeamName(team.name)]));
  const events = [...(fixture.events ?? [])]
    .filter(event => !event.rescinded)
    .sort((a, b) => (a.minute ?? 0) - (b.minute ?? 0) || (a.extra_minute ?? 0) - (b.extra_minute ?? 0) || (a.sort_order ?? 0) - (b.sort_order ?? 0));

  const goals = [];
  const cards = [];
  const subs = [];
  let homeGoals = 0;
  let awayGoals = 0;
  for (const event of events) {
    const team = teamName.get(event.participant_id) ?? null;
    if ([EVENT.goal, EVENT.ownGoal, EVENT.penalty].includes(event.type_id)) {
      if (event.participant_id === home?.id) homeGoals += 1;
      else if (event.participant_id === away?.id) awayGoals += 1;
      goals.push({
        minute: event.minute ?? null,
        injuryTime: event.extra_minute ?? null,
        type: event.type_id === EVENT.ownGoal ? "OWN" : event.type_id === EVENT.penalty ? "PENALTY" : "NORMAL",
        team,
        scorerId: event.player_id ?? null,
        scorer: event.player_name ?? "",
        assistId: event.type_id === EVENT.goal ? event.related_player_id ?? null : null,
        assist: event.type_id === EVENT.goal ? event.related_player_name ?? null : null,
        home: homeGoals,
        away: awayGoals,
      });
    } else if ([EVENT.yellow, EVENT.red, EVENT.yellowRed].includes(event.type_id)) {
      cards.push({
        minute: event.minute ?? null,
        team,
        playerId: event.player_id ?? null,
        player: event.player_name ?? "",
        card: event.type_id === EVENT.red ? "RED" : event.type_id === EVENT.yellowRed ? "YELLOW_RED" : "YELLOW",
      });
    } else if (event.type_id === EVENT.sub) {
      subs.push({
        minute: event.minute ?? null,
        team,
        inId: event.player_id ?? null,
        in: event.player_name ?? "",
        outId: event.related_player_id ?? null,
        out: event.related_player_name ?? "",
      });
    }
  }

  const players = fixture.lineups ?? [];
  const side = team => {
    const mine = players.filter(entry => entry.team_id === team?.id);
    const player = entry => ({
      id: entry.player_id ?? null,
      name: entry.player_name ?? "",
      pos: POSITION[entry.position_id] ?? null,
      num: entry.jersey_number ?? null,
      grid: entry.type_id === 11 && /^\d+:\d+$/.test(String(entry.formation_field ?? "")) ? entry.formation_field : null,
    });
    return {
      name: normalizeTeamName(team?.name),
      crest: team?.image_path ?? null,
      formation: (fixture.formations ?? []).find(entry => entry.participant_id === team?.id)?.formation ?? null,
      coach: null,
      lineup: mine.filter(entry => entry.type_id === 11).map(player),
      bench: mine.filter(entry => entry.type_id === 12).map(player),
    };
  };
  const halfTime = scoreOf(fixture, "1ST_HALF");
  const penalties = scoreOf(fixture, "PENALTY_SHOOTOUT");
  const referee = (fixture.referees ?? []).find(entry => entry.type_id === 6)?.referee;

  return {
    id: summary.id,
    status: summary.status,
    providerStatus: summary.providerStatus,
    utcDate: summary.utcDate,
    stage: summary.stage,
    group: null,
    matchday: summary.matchday,
    venue: summary.venue,
    city: summary.city,
    mapUrl: null,
    attendance: null,
    minute: summary.minute,
    score: {
      home: summary.score.home,
      away: summary.score.away,
      htHome: halfTime?.home ?? null,
      htAway: halfTime?.away ?? null,
      penHome: penalties?.home ?? null,
      penAway: penalties?.away ?? null,
    },
    home: side(home),
    away: side(away),
    goals,
    cards,
    subs,
    referee: referee?.common_name ?? referee?.name ?? null,
    playerStats: players
      .filter(entry => lineupDetail(entry, MINUTES) !== null || lineupDetail(entry, RATING) !== null)
      .map(entry => ({
        playerId: entry.player_id ?? null,
        player: entry.player_name ?? "",
        team: teamName.get(entry.team_id) ?? null,
        minutes: lineupDetail(entry, MINUTES) ?? 0,
        position: POSITION[entry.position_id] ?? null,
        tackles: 0,
        blocks: 0,
        interceptions: 0,
        rating: lineupDetail(entry, RATING),
        shots: null,
        shotsOnTarget: null,
        keyPasses: null,
        saves: null,
      })),
    source: "sportmonks",
  };
}
