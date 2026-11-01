// The Wire's AI commentary prompt. Pure module, imported by the Worker only,
// the same split as analysisPrompt.js: this owns what the model is told, the
// Worker owns the call.
//
// The model writes ONE line of colour under a moment the template has already
// stated (src/liveWire.js describeWireItem). It is never the only place a fact
// lives, and it may not author one: every figure in its reply must already
// appear in the payload it was given, which `wireLineAcceptable` enforces
// structurally rather than trusting the prompt. That is the weekly recap's
// contract (src/fantasyRecapPrompt.js) applied to live football, where a
// confidently wrong number in front of a match someone is watching is worse
// than no line at all: a rejected line simply leaves the template on its own.
//
// Names here are provider data (clubs, players), not user input, so there is no
// sanitising block like the recap's; the length cap and the control-character
// strip in wireLineAcceptable are still applied to what comes BACK.

import { WIRE_KINDS, describeImpact, describeWireItem, minuteLabel } from "./liveWire.js";
import { competitionFor } from "./competitions.js";

// Part of the stored row, so a prompt change is attributable in the data.
export const WIRE_PROMPT_VERSION = 1;

export const WIRE_LINE_MAX = 220;

export const WIRE_SCHEMA = {
  type: "object",
  properties: {
    line: {
      type: "string",
      description: "One or two sentences of live commentary colour, at most 35 words.",
    },
  },
  required: ["line"],
  additionalProperties: false,
};

export const WIRE_SYSTEM_PROMPT = `You are the fan with the best one-liners in the group chat, live-reacting on a football scores app's wire, a single timeline covering every match being played tonight.

Each request is one moment that has just happened: a goal, a red card, a goal ruled out, or full time. The app has ALREADY shown the reader the plain facts (who scored, the score, the minute). Your job is the reaction underneath: what the moment means, said the way a fan would say it.

Write one or two sentences, at most 35 words, in the "line" field.

What makes a good line:
- Meaning, not repetition. Do not restate the scorer, minute and score the reader has just seen; say why it matters. Momentum, the story of the match so far (the "earlier" events), the table consequence when the payload has one, or how it changes the night when other matches are in the "elsewhere" list.
- Use the story tags: an equaliser, a comeback, a late winner, a brace, a hat-trick, a consolation, a side down to ten men are the drama. Lead with it.
- Cross-match colour is welcome when it is true: if a rival in "elsewhere" is level or losing, you may say so, using only what the payload says.

Hard rules:
- Use only facts in the payload. Never invent statistics, xG, possession, injuries, quotes, transfer fees, records or history. You have no information about previous seasons.
- Every number you write must already appear in the payload. If in doubt, use words, not figures.
- A live match is NOT settled. Present tense; a lead is a lead, never a result. Table consequences are conditional ("as it stands", "if it stays this way"). Only a full-time moment may declare an outcome.
- Do not address the reader, do not use hashtags, emoji, bullet points or markdown.
- Never use em dashes.
- Tone: fan banter. Quick, cheeky, terrace humour, British football English. A goal can get a celebration, a howler can get a wind-up, a late winner can get pure chaos.
- Banter is about the football and nothing else: a howler, a sitter missed, a ref's call, a side bottling a lead, a keeper having a day. Never about anyone's appearance, nationality, religion, private life, money or an injury, and never mock a serious injury or anything sad off the pitch.
- No swearing, no slurs, no abuse. Cheeky, not nasty: a fan of the losing side should laugh, not report it.
- Neutral: no club is "us". Tease both sides fairly.`;

// The moment and its context as one JSON document. `recent` is this match's
// earlier wire items (oldest first), `elsewhere` the other live scores. Keys are
// short and stable so the payload stays small: this runs once per goal across a
// whole evening.
export function buildWirePrompt({ item, match, recent = [], elsewhere = [] }) {
  const facts = describeWireItem(item);
  const payload = {
    competition: competitionFor(item.competition).name,
    moment: {
      kind: item.kind,
      minute: minuteLabel(item) || null,
      team: item.team ?? null,
      player: item.player ?? null,
      assist: item.assist ?? null,
      goalType: item.goalType ?? null,
      card: item.card ?? null,
      playersLeft: item.players ?? null,
      storyTags: item.tags ?? [],
      alreadyShown: `${facts.headline} ${facts.line}`.trim(),
      table: describeImpact(item),
    },
    match: {
      home: match.homeTeam,
      away: match.awayTeam,
      status: item.kind === WIRE_KINDS.FULL_TIME ? "full time" : "live",
      minute: Number.isFinite(Number(match.minute)) ? Number(match.minute) : null,
      score: item.score ?? match.score ?? null,
      penalties: item.pens ?? null,
    },
    earlier: recent
      .filter(entry => entry.kind !== WIRE_KINDS.SUB)
      .slice(-8)
      .map(entry => `${minuteLabel(entry)} ${describeWireItem(entry).headline}: ${describeWireItem(entry).line}`.trim()),
    elsewhere: elsewhere.slice(0, 10).map(other =>
      `${other.homeTeam} ${other.score?.home ?? "-"}-${other.score?.away ?? "-"} ${other.awayTeam}${
        Number.isFinite(Number(other.minute)) ? ` (${other.minute}')` : ""}`),
  };
  return JSON.stringify(payload);
}

// Accepts the model's line only if it is short, plain, and states no figure the
// payload did not contain. Returns the cleaned line or null. Number words
// ("ten men") are fine: the check is on digits, which is where invented
// statistics live.
export function wireLineAcceptable(line, promptPayload) {
  const cleaned = String(line ?? "")
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length > WIRE_LINE_MAX) return null;
  if (/[—#*`<>]/.test(cleaned)) return null;
  const allowed = new Set(String(promptPayload ?? "").match(/\d+/g) ?? []);
  const used = cleaned.match(/\d+/g) ?? [];
  if (used.some(number => !allowed.has(number))) return null;
  return cleaned;
}
