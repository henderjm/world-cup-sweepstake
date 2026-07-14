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

// Bump when the system prompt or payload shape changes meaningfully: the version is
// part of the cache signature, so a deploy regenerates live and fresh matches with
// the new prompt instead of serving reads written by the old one.
export const ANALYSIS_PROMPT_VERSION = 2;

// Cache signature: a new analysis is worth generating whenever the signature changes.
// Score, status and penalties are always part of it (a goal, half-time, full-time or
// a fresh penalty kick regenerates on the next cron tick), and the clock component
// sets the cadence of pure time-passing updates: every 10 minutes in normal play,
// every 5 in extra time, and none at all during a shootout, where the penalty score
// itself drives regeneration kick by kick. The cron ticks every minute; this decides
// which ticks actually spend API credit.
export function analysisCacheSignature(match) {
  const score = `${match.score?.home ?? "x"}-${match.score?.away ?? "x"}`;
  const pens = match.penalties ? `${match.penalties.home}-${match.penalties.away}` : "np";
  return `v${ANALYSIS_PROMPT_VERSION}:${match.status}:${score}:${pens}:${clockBucket(match)}`;
}

function clockBucket(match) {
  if (!isLive(match.status)) return "ft";
  if (match.status === "PENALTY_SHOOTOUT") return "pens";
  const minute = match.minute ?? 0;
  const step = match.status === "EXTRA_TIME" || minute > 90 ? 5 : 10;
  return `m${step}x${Math.floor(minute / step)}`;
}

// Event addendum to the signature, from match detail (the live feed entry carries no
// cards). A red card changes a game without changing the score, so it deserves a
// fresh analysis on the next tick rather than at the next clock bucket. Yellows are
// left to the clock buckets: too frequent to justify a generation each.
export function analysisEventSignature(detail) {
  const reds = (detail?.cards ?? []).filter((card) => card.card === "RED").length;
  return `r${reds}`;
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
- Finished match: past tense, and a verdict is allowed.
- Live match: present tense, and the outcome is NOT settled. Never declare a result that has not happened: while the ball is rolling nobody has won, reached the next round, been eliminated, or banked a stage bonus. A lead is a lead, not a result ("Spain two up and in control", never "Spain cruise into the final"), and every consequence for the pot is a conditional ("if it stays like this..."). Football punishes certainty.
- The headline must be honest about the state of play: a live headline describes a game in progress, only a finished headline declares an outcome.
- Extra time or a penalty shootout in progress is the story: lead with that drama and the current shootout score if there is one.
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
