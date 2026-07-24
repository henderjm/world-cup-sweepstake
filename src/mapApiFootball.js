import { normalizeTeamName } from "./domain.js";

const STATUS = {
  TBD: "TIMED",
  NS: "TIMED",
  "1H": "IN_PLAY",
  "2H": "IN_PLAY",
  LIVE: "IN_PLAY",
  HT: "PAUSED",
  ET: "EXTRA_TIME",
  BT: "BREAK",
  P: "PENALTY_SHOOTOUT",
  FT: "FINISHED",
  AET: "FINISHED",
  PEN: "FINISHED",
  SUSP: "PAUSED",
  INT: "PAUSED",
  PST: "POSTPONED",
  CANC: "CANCELLED",
  ABD: "CANCELLED",
  AWD: "AWARDED",
  WO: "AWARDED",
};

const LIVE_MATCH_STATUSES = new Set([
  "IN_PLAY",
  "PAUSED",
  "EXTRA_TIME",
  "PENALTY_SHOOTOUT",
  "BREAK",
]);
export const TERMINAL_MATCH_STATUSES = new Set([
  "FINISHED",
  "AWARDED",
  "CANCELLED",
  "POSTPONED",
]);

export function mapApiFootballMatches(payload) {
  return (payload.response ?? []).map((entry) => {
    const { stage, matchday, group } = mapRound(entry.league?.round);
    const homeScore = numberOrNull(entry.goals?.home);
    const awayScore = numberOrNull(entry.goals?.away);
    const penHome = numberOrNull(entry.score?.penalty?.home);
    const penAway = numberOrNull(entry.score?.penalty?.away);
    const hasPenalties = penHome !== null && penAway !== null;
    const venue = entry.fixture?.venue?.name ?? null;
    const city = entry.fixture?.venue?.city ?? null;

    return {
      id: entry.fixture?.id ?? null,
      utcDate: entry.fixture?.date,
      status: STATUS[entry.fixture?.status?.short] ?? "TIMED",
      minute: entry.fixture?.status?.elapsed ?? null,
      stage,
      group,
      matchday,
      venue,
      city,
      mapUrl: venue ? googleMapsUrl(venue, city) : null,
      homeTeam: normalizeTeamName(entry.teams?.home?.name),
      awayTeam: normalizeTeamName(entry.teams?.away?.name),
      homeCrest: entry.teams?.home?.logo ?? null,
      awayCrest: entry.teams?.away?.logo ?? null,
      homeTla: null,
      awayTla: null,
      score: { home: homeScore, away: awayScore },
      penalties: hasPenalties ? { home: penHome, away: penAway } : null,
      winner: winner(entry.teams, homeScore, awayScore),
    };
  });
}

export function fixturePollingPlan(matches, now = Date.now()) {
  const twoHours = 2 * 60 * 60 * 1000;
  const fiveHours = 5 * 60 * 60 * 1000;
  const candidates = (matches ?? []).filter((match) => {
    if (TERMINAL_MATCH_STATUSES.has(match.status)) return false;
    if (LIVE_MATCH_STATUSES.has(match.status)) return true;
    const kickoff = new Date(match.utcDate).getTime();
    return Number.isFinite(kickoff) && now >= kickoff - twoHours && now <= kickoff + fiveHours;
  });

  const active = candidates.filter(
    (match) => LIVE_MATCH_STATUSES.has(match.status) || new Date(match.utcDate).getTime() <= now,
  );
  const upcoming = candidates.filter((match) => new Date(match.utcDate).getTime() > now);
  const requests = [];

  if (active.length) {
    requests.push({
      mode: active.some((match) => LIVE_MATCH_STATUSES.has(match.status)) ? "live" : "kickoff_wait",
      fixtures: active,
      ttl: 60,
    });
  }
  if (upcoming.length) {
    const secondsUntilKickoff = Math.min(
      ...upcoming.map((match) => (new Date(match.utcDate).getTime() - now) / 1000),
    );
    requests.push({
      mode: "pre_match",
      fixtures: upcoming,
      ttl: Math.max(5, Math.min(15 * 60, Math.ceil(secondsUntilKickoff) + 5)),
    });
  }

  const mode = requests.some((request) => request.mode === "live")
    ? "live"
    : requests.some((request) => request.mode === "kickoff_wait")
      ? "kickoff_wait"
      : requests.length
        ? "pre_match"
        : "idle";
  return { mode, requests };
}

export function mergeFixtureUpdates(schedule, updates) {
  const byId = new Map(updates.map((match) => [match.id, match]));
  return schedule.map((match) => byId.get(match.id) ?? match);
}

export function mapApiFootballStandingsPayload(payload) {
  return (payload.response ?? []).flatMap((response) =>
    (response.league?.standings ?? []).map((table) => ({
      type: "TOTAL",
      group: table?.[0]?.group ?? null,
      table: (table ?? []).map((row) => ({
        position: row.rank,
        team: {
          id: row.team?.id ?? null,
          name: normalizeTeamName(row.team?.name),
          shortName: normalizeTeamName(row.team?.name),
          tla: null,
          crest: row.team?.logo ?? null,
        },
        points: row.points ?? 0,
        playedGames: row.all?.played ?? 0,
        won: row.all?.win ?? 0,
        draw: row.all?.draw ?? 0,
        lost: row.all?.lose ?? 0,
        goalsFor: row.all?.goals?.for ?? 0,
        goalsAgainst: row.all?.goals?.against ?? 0,
        goalDifference: row.goalsDiff ?? 0,
      })),
    })),
  );
}

export function mapApiFootballMatchDetail(fixturePayload, lineupsPayload, eventsPayload, playersPayload) {
  const fixture = fixturePayload.response?.[0] ?? {};
  const summary = mapApiFootballMatches({ response: [fixture] })[0];
  return buildMatchDetail(summary, fixture, lineupsPayload, eventsPayload, playersPayload);
}

export function mapApiFootballMatchDetailFromSummary(summary, lineupsPayload, eventsPayload, playersPayload) {
  const lineupByName = new Map(
    (lineupsPayload.response ?? []).map((lineup) => [normalizeTeamName(lineup.team?.name), lineup.team]),
  );
  const side = (name, logo) => ({
    id: lineupByName.get(name)?.id ?? null,
    name,
    logo: lineupByName.get(name)?.logo ?? logo ?? null,
  });
  const fixture = {
    fixture: { referee: null },
    teams: {
      home: side(summary.homeTeam, summary.homeCrest),
      away: side(summary.awayTeam, summary.awayCrest),
    },
    score: { halftime: { home: null, away: null } },
  };
  return buildMatchDetail(summary, fixture, lineupsPayload, eventsPayload, playersPayload);
}

function buildMatchDetail(summary, fixture, lineupsPayload, eventsPayload, playersPayload) {
  const lineups = new Map((lineupsPayload.response ?? []).map((lineup) => [lineup.team?.id, lineup]));
  const teamNames = new Map(
    [fixture.teams?.home, fixture.teams?.away]
      .filter(Boolean)
      .map((team) => [team.id, normalizeTeamName(team.name)]),
  );
  const events = eventsPayload.response ?? [];
  const yellowCounts = new Map();
  const sentOff = new Set();
  let homeGoals = 0;
  let awayGoals = 0;

  const goals = [];
  const cards = [];
  const subs = [];
  for (const event of events) {
    const eventType = String(event.type ?? "").toLowerCase();
    const team = teamNames.get(event.team?.id) ?? normalizeTeamName(event.team?.name);
    if (eventType === "goal" && event.detail !== "Missed Penalty") {
      if (event.team?.id === fixture.teams?.home?.id) homeGoals += 1;
      else if (event.team?.id === fixture.teams?.away?.id) awayGoals += 1;
      goals.push({
        minute: event.time?.elapsed ?? null,
        injuryTime: event.time?.extra ?? null,
        type: goalType(event.detail),
        team,
        scorerId: event.player?.id ?? null,
        scorer: event.player?.name ?? "",
        assistId: event.assist?.id ?? null,
        assist: event.assist?.name ?? null,
        home: homeGoals,
        away: awayGoals,
      });
    } else if (eventType === "card") {
      const playerId = event.player?.id ?? null;
      let card = cardType(event.detail);
      if (card === "YELLOW" && playerId !== null) {
        const count = (yellowCounts.get(playerId) ?? 0) + 1;
        yellowCounts.set(playerId, count);
        if (count === 2) card = "YELLOW_RED";
      }
      if (card === "YELLOW_RED" && playerId !== null) sentOff.add(playerId);
      // A player already sent off via a synthesized YELLOW_RED cannot be carded
      // again, so drop API-Football's own explicit "Red Card" event for them
      // instead of double-counting the dismissal.
      if (card === "RED" && playerId !== null && sentOff.has(playerId)) continue;
      cards.push({
        minute: event.time?.elapsed ?? null,
        team,
        playerId,
        player: event.player?.name ?? "",
        card,
      });
    } else if (eventType === "subst") {
      subs.push({
        minute: event.time?.elapsed ?? null,
        team,
        inId: event.assist?.id ?? null,
        in: event.assist?.name ?? "",
        outId: event.player?.id ?? null,
        out: event.player?.name ?? "",
      });
    }
  }

  const mapSide = (team) => {
    const lineup = lineups.get(team?.id);
    return {
      name: normalizeTeamName(team?.name),
      crest: team?.logo ?? null,
      formation: lineup?.formation ?? null,
      coach: lineup?.coach?.name ?? null,
      lineup: (lineup?.startXI ?? []).map((entry) => mapLineupPlayer(entry.player)),
      bench: (lineup?.substitutes ?? []).map((entry) => mapLineupPlayer(entry.player)),
    };
  };

  return {
    id: summary.id,
    status: summary.status,
    utcDate: summary.utcDate,
    stage: summary.stage,
    group: summary.group,
    matchday: summary.matchday,
    venue: summary.venue,
    city: summary.city,
    mapUrl: summary.mapUrl,
    attendance: null,
    minute: summary.minute,
    score: {
      home: summary.score.home,
      away: summary.score.away,
      htHome: fixture.score?.halftime?.home ?? null,
      htAway: fixture.score?.halftime?.away ?? null,
      penHome: summary.penalties?.home ?? null,
      penAway: summary.penalties?.away ?? null,
    },
    home: mapSide(fixture.teams?.home),
    away: mapSide(fixture.teams?.away),
    goals,
    cards,
    subs,
    referee: fixture.fixture?.referee ?? null,
    playerStats: mapPlayerStats(playersPayload, teamNames),
  };
}

function mapLineupPlayer(player) {
  return {
    id: player?.id ?? null,
    name: player?.name ?? "",
    pos: player?.pos ?? null,
    num: player?.number ?? null,
  };
}

function mapPlayerStats(payload, teamNames) {
  return (payload.response ?? []).flatMap((team) =>
    (team.players ?? []).map((entry) => {
      const stats = entry.statistics?.[0] ?? {};
      return {
        playerId: entry.player?.id ?? null,
        player: entry.player?.name ?? "",
        team: teamNames.get(team.team?.id) ?? normalizeTeamName(team.team?.name),
        minutes: stats.games?.minutes ?? 0,
        position: stats.games?.position ?? null,
        tackles: stats.tackles?.total ?? 0,
        blocks: stats.tackles?.blocks ?? 0,
        interceptions: stats.tackles?.interceptions ?? 0,
      };
    }),
  );
}

function goalType(detail) {
  if (detail === "Penalty") return "PENALTY";
  if (detail === "Own Goal") return "OWN";
  return "REGULAR";
}

function cardType(detail) {
  if (/red/i.test(detail ?? "")) return /second yellow/i.test(detail ?? "") ? "YELLOW_RED" : "RED";
  if (/yellow/i.test(detail ?? "")) return "YELLOW";
  return "";
}

function mapRound(value) {
  const round = String(value ?? "").trim();
  const matchday = Number(/(?:regular season|league stage|group\s+[a-z0-9]+)\s*-\s*(\d+)/i.exec(round)?.[1]) || null;
  if (/^regular season/i.test(round)) return { stage: "REGULAR_SEASON", matchday, group: null };
  if (/^league stage/i.test(round)) return { stage: "LEAGUE_STAGE", matchday, group: null };
  if (/^1st qualifying round$/i.test(round)) return { stage: "FIRST_QUALIFYING_ROUND", matchday: null, group: null };
  if (/^2nd qualifying round$/i.test(round)) return { stage: "SECOND_QUALIFYING_ROUND", matchday: null, group: null };
  if (/^3rd qualifying round$/i.test(round)) return { stage: "THIRD_QUALIFYING_ROUND", matchday: null, group: null };
  if (/^knockout round play-offs$/i.test(round)) return { stage: "PLAYOFF_ROUND", matchday: null, group: null };
  if (/^play-offs$/i.test(round)) return { stage: "PLAYOFFS", matchday: null, group: null };
  if (/round of 16/i.test(round)) return { stage: "ROUND_OF_16", matchday, group: null };
  if (/quarter(?:-| )?final/i.test(round)) return { stage: "QUARTER_FINALS", matchday, group: null };
  if (/semi(?:-| )?final/i.test(round)) return { stage: "SEMI_FINALS", matchday, group: null };
  if (/\bfinal\b/i.test(round)) return { stage: "FINAL", matchday, group: null };
  if (/group(?: stage|\s+[a-z0-9]+)/i.test(round)) {
    const group = /group\s+([a-z0-9]+)/i.exec(round)?.[1]?.toUpperCase();
    return { stage: "GROUP_STAGE", matchday, group: group ? `GROUP_${group}` : null };
  }
  if (round) {
    return {
      stage: round.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, ""),
      matchday,
      group: null,
    };
  }
  return { stage: null, matchday: null, group: null };
}

function googleMapsUrl(venue, city) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    [venue, city].filter(Boolean).join(", "),
  )}`;
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function winner(teams, home, away) {
  if (teams?.home?.winner === true) return "HOME_TEAM";
  if (teams?.away?.winner === true) return "AWAY_TEAM";
  if (home === null || away === null || home === away) return home === away && home !== null ? "DRAW" : null;
  return home > away ? "HOME_TEAM" : "AWAY_TEAM";
}
