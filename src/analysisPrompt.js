// AI match analysis prompt. Cross-environment contract like mapFootballDataMatches:
// the Worker imports this from ../src/ so the prompt is assembled server-side from
// trusted feed data (the client only ever sends a match id). Pure module: no fetch,
// no DOM, no Anthropic client. The Worker owns the API call; this owns what it says.

import {
  buildTeamPerformance,
  mapFootballDataStandings,
  normalizeTeamName,
} from "./domain.js";
import { competitionFor, zoneFor } from "./competitions.js";
import { isFinished, isLive } from "./format.js";

// Analysis exists only once there is a game to talk about.
export function analysisEligible(match) {
  return isLive(match?.status) || isFinished(match?.status);
}

// Bump when the system prompt or payload shape changes meaningfully: the version is
// part of the cache signature, so a deploy regenerates live and fresh matches with
// the new prompt instead of serving reads written by the old one.
export const ANALYSIS_PROMPT_VERSION = 3;

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
    context: {
      type: "string",
      description:
        "Two to four sentences on what this means for the table: the title race, European places, relegation, or a knockout tie, whichever actually applies to these sides.",
    },
  },
  required: ["headline", "match", "context"],
  additionalProperties: false,
};

export const ANALYSIS_SYSTEM_PROMPT = `You are the resident AI analyst for a live football scores hub, writing short FotMob-style summaries.

You get one JSON payload describing a single match plus league context: where both sides sit in the table, the zone bands that matter (European places, relegation), recent form, and the leaders. Respond with the three fields of the schema:
- "headline": at most nine words, punchy.
- "match": two to four sentences on the football itself.
- "context": two to four sentences on what the result means for the table. Talk about the stakes that actually apply to these two sides: the title race, Europe, relegation, mid-table drift. Use positions and points from the payload.

Rules:
- Finished match: past tense, and a verdict is allowed.
- Live match: present tense, and the outcome is NOT settled. Never declare a result that has not happened: while the ball is rolling nobody has won, moved up the table, or been relegated. A lead is a lead, not a result ("Arsenal two up and in control", never "Arsenal go top"), and every consequence for the table is a conditional ("if it stays like this..."). Football punishes certainty.
- The headline must be honest about the state of play: a live headline describes a game in progress, only a finished headline declares an outcome.
- Extra time or a penalty shootout in progress is the story: lead with that drama and the current shootout score if there is one.
- Use only facts present in the payload. The feed has no xG or possession stats, so never invent numbers. Do not diagnose injuries beyond a substitution you can see.
- Table claims must be arithmetic you can do from the payload (points, positions, games played). Never guess at other results happening elsewhere.
- Tone: sharp, warm, a little wry. Plain sentences, no bullet points, no markdown.
- Never use em dashes.`;

// Builds the user prompt from the mapped match detail and the live feed. Returns a
// JSON string so the payload survives any transport untouched.
export function buildAnalysisPrompt(detail, live) {
  const matches = live?.matches ?? [];
  const competition = competitionFor(live?.competition);
  const standings = mapFootballDataStandings(
    { standings: live?.standings ?? [] },
    competition.zones,
  );
  const performance = buildTeamPerformance(matches);
  const homeTeam = normalizeTeamName(detail.home?.name);
  const awayTeam = normalizeTeamName(detail.away?.name);

  const payload = {
    competition: competition.name,
    match: {
      stage: detail.stage,
      group: detail.group,
      matchday: detail.matchday ?? null,
      venue: detail.venue,
      city: detail.city,
      kickoffUtc: detail.utcDate,
      status: detail.status,
      minute: detail.minute,
      home: sideContext(homeTeam, detail.home, standings, performance),
      away: sideContext(awayTeam, detail.away, standings, performance),
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
    table: tableContext(standings, competition, homeTeam, awayTeam),
  };

  return JSON.stringify(payload);
}

function sideContext(team, side, standings, performance) {
  const standing = standings.get(team);
  const stats = performance.get(team);
  return {
    team,
    formation: side?.formation ?? null,
    coach: side?.coach ?? null,
    position: standing?.position ?? null,
    points: standing?.points ?? null,
    played: standing?.played ?? null,
    goalDifference: standing?.goalDifference ?? null,
    zone: standing?.zone?.label ?? null,
    recentForm: stats?.form?.join("") || null,
  };
}

// A compact table picture: the zone bands, the top of the table, the bottom, and the
// neighbourhood around each side, deduplicated. Enough for honest arithmetic about
// the title race, Europe and relegation without shipping all twenty rows.
function tableContext(standings, competition, homeTeam, awayTeam) {
  const rows = [...standings.values()].sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
  if (!rows.length) return null;

  const interesting = new Set();
  rows.slice(0, 4).forEach((row) => interesting.add(row.position));
  rows.slice(-3).forEach((row) => interesting.add(row.position));
  [homeTeam, awayTeam].forEach((team) => {
    const standing = standings.get(team);
    if (!standing?.position) return;
    [standing.position - 1, standing.position, standing.position + 1].forEach((position) =>
      interesting.add(position),
    );
  });

  return {
    zones: (competition.zones ?? []).map((zone) => ({
      label: zone.label,
      positions: `${zone.from}-${zone.to}`,
    })),
    rows: rows
      .filter((row) => interesting.has(row.position))
      .map((row) => ({
        position: row.position,
        team: row.team,
        played: row.played,
        points: row.points,
        goalDifference: row.goalDifference,
        zone: zoneFor(row.position, competition.zones)?.label ?? null,
      })),
  };
}
