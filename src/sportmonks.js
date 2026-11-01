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

export const SPORTMONKS_LEAGUES = { PL: 8, CL: 2 };
export const MATCH_CENTRE_INCLUDES = "participants;statistics;xGFixture;pressure;sidelined.sideline.player;sidelined.sideline.type";

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
  const team = side => fixture.participants?.find(entry => entry.meta?.location === side)?.name ?? null;
  return {
    provider: "sportmonks",
    fixtureId: fixture.id,
    home: team("home"),
    away: team("away"),
    teamStats,
    sidelined,
    pressure: [...byMinute.values()].sort((a, b) => a.minute - b.minute),
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
