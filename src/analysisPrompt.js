// AI match analysis prompt. Cross-environment contract like mapFootballDataMatches:
// the Worker imports this from ../src/ so the prompt is assembled server-side from
// trusted feed data (the client only ever sends a match id). Pure module: no fetch,
// no DOM, no Anthropic client. The Worker owns the API call; this owns what it says.

import { ENTRANTS, ownerOf, currentPrizes, woodenSpoon } from "./data.js";
import { buildLeaderboard, buildTeamPerformance, normalizeTeamName } from "./domain.js";
import { isFinished, isLive } from "./format.js";

// Analysis exists only once there is a game to talk about.
export function analysisEligible(match) {
  return isLive(match?.status) || isFinished(match?.status);
}

// Cache signature: a new analysis is worth generating when the score, status or
// penalties change, or every 10 live minutes so the narrative keeps up with the clock
// without burning API credit on near-identical game states (a goal busts the cache
// immediately via the score part).
export function analysisCacheSignature(match) {
  const score = `${match.score?.home ?? "x"}-${match.score?.away ?? "x"}`;
  const pens = match.penalties ? `${match.penalties.home}-${match.penalties.away}` : "np";
  const clock = isLive(match.status) ? `m${Math.floor((match.minute ?? 0) / 10)}` : "ft";
  return `${match.status}:${score}:${pens}:${clock}`;
}

// Structured output schema: the model must return exactly these three strings.
export const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string", description: "Punchy one-liner, at most nine words." },
    match: {
      type: "string",
      description: "Two to four sentences on the football itself: key events, momentum, what to watch, or what decided it.",
    },
    sweepstake: {
      type: "string",
      description: "Two to four sentences on what this means for the sweepstake money and leaderboard, naming the owners involved.",
    },
  },
  required: ["headline", "match", "sweepstake"],
  additionalProperties: false,
};

export const ANALYSIS_SYSTEM_PROMPT = `You are the resident AI analyst for the Goon Squad World Cup 2026 sweepstake hub, writing short FotMob-style summaries for a group of sixteen friends.

How the sweepstake works:
- 16 entrants paid EUR 10 each into a EUR 160 pot. Each drew three national teams before the tournament.
- Real money follows real outcomes: EUR 100 to whoever owns the world champions, EUR 30 to the owner of the runners-up, EUR 30 for the wooden spoon (first team confirmed dead last in its group).
- There is also a points leaderboard for bragging rights only: league points x10 + goal difference x2 + goals scored + stage bonuses (reaching the last 32: 15, last 16: 25, quarter-final: 40, semi-final: 60, third-place match: 70, final runner-up: 85, champions: 120). A stage bonus is credited once that stage's match has finished.

You get one JSON payload describing a single match plus the sweepstake context around it. Respond with the three fields of the schema:
- "headline": at most nine words, punchy.
- "match": two to four sentences on the football itself.
- "sweepstake": two to four sentences on what the result means for the money and the leaderboard. Name the owners.

Rules:
- Live match: present tense. Finished match: past tense.
- Use only facts present in the payload. The feed has no xG or possession stats, so never invent numbers. Do not diagnose injuries beyond a substitution you can see.
- Tone: sharp, warm, light banter between friends. Plain sentences, no bullet points, no markdown.
- Write money as "EUR 100". Never use em dashes.`;

// Builds the user prompt from the mapped match detail and the live feed. Returns a
// JSON string so the payload survives any transport untouched.
export function buildAnalysisPrompt(detail, live) {
  const matches = live?.matches ?? [];
  const leaderboard = buildLeaderboard(ENTRANTS, buildTeamPerformance(matches));
  const homeTeam = normalizeTeamName(detail.home?.name);
  const awayTeam = normalizeTeamName(detail.away?.name);
  const prizes = currentPrizes(matches);
  const spoon = woodenSpoon(matches);

  const payload = {
    match: {
      stage: detail.stage,
      group: detail.group,
      venue: detail.venue,
      city: detail.city,
      kickoffUtc: detail.utcDate,
      status: detail.status,
      minute: detail.minute,
      home: sideContext(homeTeam, detail.home),
      away: sideContext(awayTeam, detail.away),
      score: {
        home: detail.score?.home ?? null,
        away: detail.score?.away ?? null,
        halfTime:
          detail.score?.htHome != null ? `${detail.score.htHome}-${detail.score.htAway}` : null,
        penalties:
          detail.score?.penHome != null ? `${detail.score.penHome}-${detail.score.penAway}` : null,
      },
      events: {
        goals: detail.goals ?? [],
        cards: detail.cards ?? [],
        substitutions: detail.subs ?? [],
      },
    },
    sweepstake: {
      potEur: 160,
      prizesEur: { champion: 100, runnerUp: 30, woodenSpoon: 30 },
      champion: prizes.champion,
      runnerUp: prizes.runnerUp,
      woodenSpoon: spoon,
      homeOwner: ownerContext(homeTeam, leaderboard),
      awayOwner: ownerContext(awayTeam, leaderboard),
      leaderboard: leaderboard.map((row) => ({ rank: row.rank, name: row.name, score: row.score })),
    },
    tournament: {
      recentKnockoutResults: knockoutResults(matches),
      upcomingKnockout: upcomingKnockout(matches),
    },
  };

  return JSON.stringify(payload);
}

function sideContext(team, side) {
  return {
    team,
    owner: ownerOf(team),
    formation: side?.formation ?? null,
    coach: side?.coach ?? null,
  };
}

function ownerContext(team, leaderboard) {
  const owner = ownerOf(team);
  const row = owner ? leaderboard.find((entry) => entry.name === owner) : null;
  if (!owner || !row) return { name: owner ?? null };
  return {
    name: owner,
    leaderboardRank: row.rank,
    leaderboardScore: row.score,
    teams: row.teams.map((teamRow) => ({
      team: teamRow.name,
      score: teamRow.score,
      stageBonus: teamRow.stageBonus,
      inThisMatch: teamRow.name === team,
    })),
  };
}

// Knockout results from the last 16 onward keep the payload small while still giving
// the model the road each side has travelled and who is left in the way.
const NARRATED_STAGES = new Set(["LAST_16", "QUARTER_FINALS", "SEMI_FINALS", "THIRD_PLACE", "FINAL"]);

function knockoutResults(matches) {
  return matches
    .filter((match) => NARRATED_STAGES.has(match.stage) && isFinished(match.status))
    .map((match) => {
      const pens = match.penalties ? ` (${match.penalties.home}-${match.penalties.away} pens)` : "";
      return `${match.stage}: ${match.homeTeam} ${match.score.home}-${match.score.away} ${match.awayTeam}${pens}`;
    });
}

function upcomingKnockout(matches) {
  return matches
    .filter(
      (match) =>
        match.stage !== "GROUP_STAGE" && !isFinished(match.status) && !isLive(match.status),
    )
    .map((match) => ({
      stage: match.stage,
      date: match.utcDate,
      home: match.homeTeam,
      away: match.awayTeam,
      homeOwner: ownerOf(match.homeTeam),
      awayOwner: ownerOf(match.awayTeam),
    }));
}
