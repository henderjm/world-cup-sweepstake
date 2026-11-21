// Sportmonks, the V2 match-centre provider (docs/release-plan-matchday-2.md,
// V2 section). Pure, shared by the Worker and the tests. Phase 1 is a HYBRID:
// API-Football stays the source of fixture ids, scores, events and line-ups
// (everything fantasy, predictions and push are keyed on), and Sportmonks adds
// the team statistics, xG and pressure API-Football cannot give us live. A
// fixture is joined by its UTC kickoff date plus both canonical club names,
// so no id table has to be maintained.
//
// Response keys arrive lower case ("xgfixture"), statistics carry their side
// as `location`, and every value is `data.value`. A statistic Sportmonks did
// not send is absent from the result, never zero.

import { normalizeTeamName } from "./domain.js";
import { compactDetails } from "./playerStats.js";

export const SPORTMONKS_LEAGUES = { PL: 8, CL: 2 };
export const MATCH_CENTRE_INCLUDES = "participants;statistics;xGFixture;pressure;sidelined.sideline.player;sidelined.sideline.type;lineups.details;coaches;metadata";
// Predictions are a separate add-on: an include the plan lacks 403s the WHOLE
// request, so they are read on their own call and the centre survives without.
export const PREDICTION_INCLUDES = "participants;predictions";

// Metadata type ids (verified on a Premier League fixture, 21 November 2026).
const META = { homeColours: 161, awayColours: 162, attendance: 578 };
// Prediction type ids: model probabilities only. Valuebet (33) carries
// bookmaker odds and is deliberately never read (no betting, PRD principles).
const PREDICTION = { result: 237, btts: 231, over25: 235, correctScore: 240 };

// Statistic type ids (verified against a real fixture on 31 October 2026).
const STAT_TYPES = {
  34: "corners",
  42: "shots",
  45: "possession",
  56: "fouls",
  64: "woodwork",
  80: "passes",
  86: "shotsOnTarget",
  580: "bigChances",
};
// xG is a separate include; Basic xG arrives only after full time.
const XG_TYPES = { 5304: "xg", 5305: "xgOnTarget" };

function sideOf(fixture, participantId) {
  return fixture.participants?.find(team => team.id === participantId)?.meta?.location ?? null;
}

function collect(rows, types, target) {
  for (const row of rows ?? []) {
    const key = types[row.type_id];
    const side = row.location;
    const value = Number(row.data?.value);
    if (!key || (side !== "home" && side !== "away") || !Number.isFinite(value)) continue;
    target[side][key] = value;
  }
}

// Team statistics, xG and pressure for one Sportmonks fixture, in the shape
// the V2 Match page reads (`detail.teamStats`, `detail.pressure`).
export function mapMatchCentre(fixture) {
  if (!fixture) return null;
  const teamStats = { home: {}, away: {} };
  collect(fixture.statistics, STAT_TYPES, teamStats);
  collect(fixture.xgfixture, XG_TYPES, teamStats);
  const byMinute = new Map();
  for (const point of fixture.pressure ?? []) {
    const side = sideOf(fixture, point.participant_id);
    const value = Number(point.pressure);
    if (!side || !Number.isFinite(point.minute) || !Number.isFinite(value)) continue;
    const entry = byMinute.get(point.minute) ?? { minute: point.minute, home: 0, away: 0 };
    entry[side] = value;
    byMinute.set(point.minute, entry);
  }
  // Injured and suspended players for each side, with the reason. A player
  // name with no reason is still listed; one with no name is dropped.
  const sidelined = { home: [], away: [] };
  for (const entry of fixture.sidelined ?? []) {
    const side = sideOf(fixture, entry.participant_id);
    const player = entry.sideline?.player;
    const name = String(player?.display_name ?? player?.common_name ?? player?.name ?? "").trim();
    if (!side || !name) continue;
    sidelined[side].push({
      name,
      reason: entry.sideline?.type?.name ?? null,
      suspended: entry.sideline?.category === "suspension",
    });
  }
  // Every listed player's figures for this match, keyed for the player
  // sheet. The app joins its own line-up to these by side and shirt number,
  // which both providers carry, so no player id table is needed.
  const players = { home: [], away: [] };
  for (const entry of fixture.lineups ?? []) {
    const side = sideOf(fixture, entry.team_id);
    if (!side) continue;
    players[side].push({
      playerId: entry.player_id ?? null,
      num: entry.jersey_number ?? null,
      name: entry.player_name ?? "",
      keeper: entry.position_id === 24,
      stats: compactDetails(entry.details),
    });
  }
  const team = side => fixture.participants?.find(entry => entry.meta?.location === side)?.name ?? null;
  const coaches = { home: null, away: null };
  for (const coach of fixture.coaches ?? []) {
    const side = sideOf(fixture, coach.meta?.participant_id);
    const name = String(coach.display_name ?? coach.common_name ?? coach.name ?? "").trim();
    if (side && name) coaches[side] = name;
  }
  const meta = typeId => (fixture.metadata ?? []).find(entry => entry.type_id === typeId)?.values ?? null;
  const colour = value => (/^#[0-9a-f]{6}$/i.test(String(value ?? "")) ? value : null);
  const attendance = Number(meta(META.attendance)?.attendance);
  return {
    provider: "sportmonks",
    fixtureId: fixture.id,
    home: team("home"),
    away: team("away"),
    seasonId: fixture.season_id ?? null,
    teamStats,
    sidelined,
    players,
    coaches,
    attendance: Number.isFinite(attendance) && attendance > 0 ? attendance : null,
    colours: { home: colour(meta(META.homeColours)?.participant), away: colour(meta(META.awayColours)?.participant) },
    pressure: [...byMinute.values()].sort((a, b) => a.minute - b.minute),
  };
}

// The pre-match model for one fixture: full-time result, both teams to
// score, over 2.5 goals and the likeliest exact score, all as percentages.
// Null when Sportmonks sent no result probability (plan lapsed, minor
// fixture), so the page simply omits the section.
export function mapPredictions(fixture) {
  const byType = new Map((fixture?.predictions ?? []).map(entry => [entry.type_id, entry.predictions]));
  const pct = value => (Number.isFinite(Number(value)) ? Math.round(Number(value)) : null);
  const result = byType.get(PREDICTION.result);
  if (!result || pct(result.home) === null || pct(result.away) === null || pct(result.draw) === null) return null;
  // "Other_1" style buckets are "any other score", not a score to show.
  const scores = Object.entries(byType.get(PREDICTION.correctScore)?.scores ?? {})
    .filter(([score, value]) => /^\d+-\d+$/.test(score) && Number.isFinite(Number(value)))
    .sort((a, b) => b[1] - a[1]);
  return {
    home: pct(result.home),
    draw: pct(result.draw),
    away: pct(result.away),
    btts: pct(byType.get(PREDICTION.btts)?.yes),
    over25: pct(byType.get(PREDICTION.over25)?.yes),
    likelyScore: scores[0] ? { score: scores[0][0], chance: pct(scores[0][1]) } : null,
  };
}

// The Sportmonks fixture that is the same match as an app match: same UTC
// kickoff date and both clubs equal after normalizeTeamName. Null when there
// is no unambiguous match, so a wrong join can never put one match's numbers
// on another's page.
export function findSportmonksFixture(fixtures, match) {
  const day = String(match?.utcDate ?? "").slice(0, 10);
  const home = normalizeTeamName(match?.homeTeam);
  const away = normalizeTeamName(match?.awayTeam);
  const hits = (fixtures ?? []).filter(fixture => {
    const name = side => normalizeTeamName(fixture.participants?.find(team => team.meta?.location === side)?.name);
    return String(fixture.starting_at ?? "").slice(0, 10) === day && name("home") === home && name("away") === away;
  });
  return hits.length === 1 ? hits[0] : null;
}
