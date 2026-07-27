// Pure logic for the signed-out "try a draft" demo: draft a 15-player squad
// against bots, then simulate a full 38-gameweek season and produce a report
// card. No DOM, no fetch, no server. This module deliberately reuses the real
// rules rather than re-deriving them:
//   - src/draftLogic.js: resolvePick/validatePick/autoPick (snake order + the
//     scarcest-bucket-first autopick, the bots' brain) and roundRobinSchedule
//     (the same H2H fixture generator the real league would use).
//   - src/fantasyDraft.js: reduceDraftMessage, the exact pick -> clock message
//     reducer the live WebSocket client applies, so the demo's local draft
//     loop advances identically to a real draft room's state machine.
//   - src/fantasy.js: SQUAD_SIZE/SQUAD_SLOTS.
//   - src/fantasyLineups.js: defaultLineup, the same formation-fill a real
//     manager who never touches their lineup gets.
//   - src/fantasyGameweek.js: rosterGameweekPoints (captain doubling) and
//     standingsFromFixtures (win/draw/loss ranking).
// The only genuinely new logic here is the seeded per-gameweek score generator
// (the real season hasn't been played yet, so there is nothing to reuse) and
// the report-card derivations (MVP, weak link, best gameweek, rival).

import { autoPick, resolvePick, roundRobinSchedule, validatePick } from "./draftLogic.js";
import { SQUAD_SIZE, SQUAD_SLOTS } from "./fantasy.js";
import { formatOrdinal, reduceDraftMessage } from "./fantasyDraft.js";
import { defaultLineup } from "./fantasyLineups.js";
import { rosterGameweekPoints, standingsFromFixtures } from "./fantasyGameweek.js";

// -- Setup ------------------------------------------------------------------

export const DEMO_LEAGUE_SIZES = [4, 6, 8];
export const DEFAULT_DEMO_LEAGUE_SIZE = 6;
export const DEFAULT_DEMO_MANAGER_NAME = "You";
export const DEMO_HUMAN_ID = "you";

// Fixed, deterministic bot roster: no randomness needed here, a league of up
// to 8 only ever needs 7 of these. Names are flavour only, never read by any
// pure derivation below.
const BOT_MANAGER_NAMES = [
  "Roy's Ravens",
  "Statto United",
  "Late Kickoffs",
  "Bench Warmers FC",
  "Set Piece Merchants",
  "Aggro Aggregate",
  "VAR Room Villains",
  "Corner Count XI",
  "Fixture Congestion",
];

// A blank/whitespace-only name falls back to DEFAULT_DEMO_MANAGER_NAME so the
// setup screen can be skipped entirely (see CLAUDE.md/the spec: "default
// something sensible so it can be skipped"). Caller is responsible for
// escaping `managerName` before it ever reaches the DOM or share text (it is
// user-supplied input).
export function createDemoMembers(size, managerName) {
  const name = String(managerName ?? "").trim() || DEFAULT_DEMO_MANAGER_NAME;
  const members = [{ userId: DEMO_HUMAN_ID, name, isBot: false }];
  for (let i = 1; i < size; i++) {
    members.push({ userId: `bot-${i}`, name: BOT_MANAGER_NAMES[(i - 1) % BOT_MANAGER_NAMES.length], isBot: true });
  }
  return { members, humanId: DEMO_HUMAN_ID };
}

// -- Draft: a thin local loop over the real snake-draft rules ----------------
//
// The "room" shape here is intentionally identical to the live draft room's
// state (see src/fantasyDraft.js's reduceDraftMessage and src/fantasyView.js's
// renderFantasyDraftRoom): { memberIds, round, pickInRound, overallPick,
// onClockUserId, rosters, picks, status, lastError }. That lets the demo
// screen call the exact same renderer the real product uses.

// Builds the initial room state via a synthetic "state" message, the same
// shape the Durable Object sends a freshly connected socket.
export function initDemoDraftRoom(memberIds) {
  const first = resolvePick(memberIds, 1, SQUAD_SIZE);
  return reduceDraftMessage(null, {
    type: "state",
    memberIds,
    round: 1,
    pickInRound: 1,
    overallPick: 1,
    onClockUserId: first?.userId ?? null,
    rosters: Object.fromEntries(memberIds.map((id) => [id, []])),
    picks: [],
    status: "drafting",
  });
}

export function draftedPlayerIds(room) {
  return new Set(
    Object.values(room?.rosters ?? {})
      .flat()
      .map((player) => player.id),
  );
}

// Applies one pick to the room, exactly mirroring what the real server does:
// a "pick" message (appends to picks/rosters, advances overallPick, blanks
// onClockUserId) immediately followed by either a "clock" message naming the
// next picker (via resolvePick, the same function that decides whose turn it
// really is) or a "complete" message once every round is done. Rejects an
// illegal pick (already drafted, bucket full) by returning the room
// unchanged rather than throwing, so a stale click after state has moved on
// is a safe no-op.
export function applyDemoPick(room, player) {
  if (!room || room.status === "complete") return room;
  const current = resolvePick(room.memberIds, room.overallPick, SQUAD_SIZE);
  if (!current || !player) return room;

  const validation = validatePick({
    roster: room.rosters?.[current.userId] ?? [],
    draftedIds: draftedPlayerIds(room),
    player,
    squadSlots: SQUAD_SLOTS,
  });
  if (!validation.valid) return room;

  let next = reduceDraftMessage(room, {
    type: "pick",
    round: current.round,
    pickInRound: current.pickInRound,
    overallPick: room.overallPick,
    userId: current.userId,
    player,
  });

  const upcoming = resolvePick(next.memberIds, next.overallPick, SQUAD_SIZE);
  next = upcoming
    ? reduceDraftMessage(next, {
        type: "clock",
        onClockUserId: upcoming.userId,
        overallPick: next.overallPick,
        round: upcoming.round,
        pickInRound: upcoming.pickInRound,
      })
    : reduceDraftMessage(next, { type: "complete" });
  return next;
}

// The deterministic pick whoever is currently on the clock would get from a
// timeout: reuses draftLogic.js's autoPick directly against the pool with
// every already-drafted player removed. Used both for bots (always) and for
// the human's own clock expiring (the same fallback the real product uses).
export function autoPickForRoom(room, pool) {
  if (!room || room.status === "complete") return null;
  const current = resolvePick(room.memberIds, room.overallPick, SQUAD_SIZE);
  if (!current) return null;
  const drafted = draftedPlayerIds(room);
  const available = (pool ?? []).filter((player) => player?.id != null && !drafted.has(player.id));
  return autoPick(available, room.rosters?.[current.userId] ?? [], SQUAD_SLOTS);
}

export function isDemoDraftComplete(room) {
  return room?.status === "complete";
}

// UI pacing: bots always pick fast, on their own fixed delay regardless of
// the human's chosen pick clock. Centralised here (not scattered as magic
// numbers in the view layer) even though only the constant itself is
// meaningfully "pure".
export const DEMO_BOT_PICK_DELAY_MS = 550;

// The human's own pick clock is a setup-screen choice, not a fixed constant:
// a small set of sensible seconds-per-pick options plus an untimed option
// (no autopick ever fires on the human's own turn - bots are unaffected,
// they always use DEMO_BOT_PICK_DELAY_MS). 30s is the default: fast enough to
// keep the "5 minutes" pitch honest, slow enough not to feel rushed on a
// first try.
export const DEMO_CLOCK_SECONDS_OPTIONS = [10, 30, 60];
export const DEMO_CLOCK_UNTIMED = "untimed";
export const DEFAULT_DEMO_CLOCK_SECONDS = 30;

// Milliseconds for a chosen pick-clock option, or null for untimed/an
// unrecognised value - the caller's signal to never start an autopick timer
// for the human's own turn. Never throws on a bogus value; treats it the
// same as untimed rather than guessing a default.
export function demoClockDurationMs(choice) {
  if (choice === DEMO_CLOCK_UNTIMED || choice == null) return null;
  const seconds = Number(choice);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

// -- Season simulation --------------------------------------------------------

export const DEMO_SEASON_GAMEWEEKS = 38;

// A player pool file may ship without prior-season tier enrichment (see
// src/fantasyPlayerTier.js) - every tier here defaults to "unknown" rather
// than crashing or silently treating an unrecognised/missing tier as
// "starter", matching TIER_ORDER's own "no evidence either way" semantics.
export const DEMO_TIER_MEAN = { starter: 5.6, squad: 3.6, unknown: 2.6, fringe: 1.1 };
export const DEMO_TIER_STDDEV = { starter: 3.2, squad: 2.5, unknown: 2.1, fringe: 1.5 };
export const DEMO_TIER_BIG_GAME_CHANCE = { starter: 0.12, squad: 0.07, unknown: 0.05, fringe: 0.02 };

function tierKey(tier) {
  return DEMO_TIER_MEAN[tier] != null ? tier : "unknown";
}

// Position weighting, layered on top of the tier weighting above: the tier
// says "how nailed-on this player is", the position says "how does this
// player's role convert minutes into fantasy points". Without this, a
// starter goalkeeper draws from the exact same distribution as a starter
// forward, which is how a keeper ended up as demo MVP (the bug this table
// fixes). Multipliers are a rough, directionally-honest read of SCORING
// (src/fantasy.js), not invented from nothing: forwards and midfielders live
// off goals/assists every week (goal 4-5pts, assist 3pts) so they carry the
// highest mean and the fattest right tail; defenders score goals worth more
// per goal (6pts) but far less often, and pick up the same clean-sheet bonus
// as a keeper (4pts), landing them in the middle; goalkeepers have no
// assists and the same rare goal chance as a defender, so they get the
// lowest mean of the four, with a slightly suppressed spread (an
// appearance+clean-sheet week is a fairly flat 6ish points) but not a
// suppressed big-game chance, since a clean sheet plus save/penalty bonus
// swings can still occasionally be their best week of the season.
export const DEMO_POSITION_MEAN_MULTIPLIER = { FWD: 1.25, MID: 1.15, DEF: 0.85, GK: 0.55 };
export const DEMO_POSITION_STDDEV_MULTIPLIER = { FWD: 1.1, MID: 1.0, DEF: 0.85, GK: 0.65 };
export const DEMO_POSITION_BIG_GAME_MULTIPLIER = { FWD: 1.3, MID: 1.2, DEF: 1.0, GK: 0.9 };

// A missing/unrecognised position (e.g. a pool entry with no position field)
// falls back to a neutral 1.0 multiplier on every axis: "no evidence either
// way" for the position, exactly like tierKey's "unknown" fallback above,
// rather than silently defaulting to any one real position's shape.
function positionMultipliers(position) {
  const key = DEMO_POSITION_MEAN_MULTIPLIER[position] != null ? position : null;
  if (!key) return { mean: 1, stddev: 1, bigGame: 1 };
  return {
    mean: DEMO_POSITION_MEAN_MULTIPLIER[key],
    stddev: DEMO_POSITION_STDDEV_MULTIPLIER[key],
    bigGame: DEMO_POSITION_BIG_GAME_MULTIPLIER[key],
  };
}

// FNV-1a style string hash, folded into a 32-bit unsigned int: gives an
// independent-looking seed per (seed, playerId, gameweek) triple without
// needing to carry sequential RNG state between calls, so any single
// player-gameweek score can be recomputed in isolation (and unit-tested) from
// its own inputs alone.
function hashSeed(...parts) {
  let hash = 2166136261 >>> 0;
  const str = parts.join(":");
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// mulberry32: a small, fast, deterministic PRNG. Same seed in, same sequence
// of floats in [0, 1) out, every time, on any JS engine - the property the
// "a given seed replays identically" requirement depends on.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One player's fantasy points for one gameweek: deterministic given
// (seed, playerId, gameweek, tier, position), with real variance (not a flat
// average) and a small chance of an explosive "big game" bonus, more likely
// for a higher tier and for an attacking position (see the position
// multipliers above). The base draw is an Irwin-Hall(3) approximation of a
// normal distribution (sum of three uniforms, mean 1.5, sd ~0.5) scaled to
// the tier's own mean/spread and then reweighted by position, so scores
// cluster around a plausible average for that tier AND that role rather
// than being uniformly spread across positions. Never negative. `position`
// is optional: a missing or unrecognised value gets a neutral 1.0
// multiplier (see positionMultipliers), matching an unrecognised tier's own
// fallback to "unknown" rather than crashing or guessing a position.
export function seededPlayerGameweekPoints(seed, playerId, gameweek, tier, position) {
  const key = tierKey(tier);
  const { mean: meanMult, stddev: stddevMult, bigGame: bigGameMult } = positionMultipliers(position);
  const rng = mulberry32(hashSeed(seed, playerId, gameweek));
  const mean = DEMO_TIER_MEAN[key] * meanMult;
  const stddev = DEMO_TIER_STDDEV[key] * stddevMult;
  const bigGameChance = Math.min(1, DEMO_TIER_BIG_GAME_CHANCE[key] * bigGameMult);
  const u = rng() + rng() + rng();
  const z = (u - 1.5) / 0.5;
  let points = mean + z * stddev;
  if (rng() < bigGameChance) points += 4 + rng() * 6;
  return Math.max(0, Math.round(points));
}

// Runs the whole compressed season: every manager's lineup is their real
// defaultLineup over whatever roster the draft left them with, fixed for the
// entire season (no in-season transfers or waivers in the demo - there is no
// wire to work, so nothing would ever change it anyway). Fixtures come from
// the real roundRobinSchedule; final standings from the real
// standingsFromFixtures. `rosters` is a Map<userId, player[]>.
export function simulateDemoSeason({ seed, members, rosters, gameweeks = DEMO_SEASON_GAMEWEEKS }) {
  const memberIds = members.map((member) => member.userId);
  const lineups = new Map(memberIds.map((id) => [id, defaultLineup(rosters.get(id) ?? [])]));

  const rosterById = new Map();
  for (const roster of rosters.values()) {
    for (const player of roster ?? []) rosterById.set(player.id, player);
  }

  const gwPointsByUser = new Map(memberIds.map((id) => [id, []]));
  const playerSeasonTotals = new Map(memberIds.map((id) => [id, new Map()]));

  for (let gw = 1; gw <= gameweeks; gw++) {
    const pointsMap = new Map();
    for (const player of rosterById.values()) {
      pointsMap.set(player.id, seededPlayerGameweekPoints(seed, player.id, gw, player.tier, player.position));
    }
    for (const userId of memberIds) {
      const { points, breakdown } = rosterGameweekPoints(lineups.get(userId), pointsMap);
      gwPointsByUser.get(userId).push(points);
      const totals = playerSeasonTotals.get(userId);
      for (const entry of breakdown) {
        totals.set(entry.playerId, (totals.get(entry.playerId) ?? 0) + entry.points);
      }
    }
  }

  const fixtures = roundRobinSchedule(memberIds, gameweeks).map((fixture) => ({
    ...fixture,
    homeScore: gwPointsByUser.get(fixture.homeUserId)[fixture.gameweek - 1],
    awayScore: gwPointsByUser.get(fixture.awayUserId)[fixture.gameweek - 1],
  }));

  const standings = standingsFromFixtures(fixtures, members);

  return { fixtures, standings, gwPointsByUser, playerSeasonTotals, lineups, rosterById };
}

// Standings through gameweek `throughGameweek` only (for the animated roll):
// re-derives from the same real standingsFromFixtures, just fed a smaller
// slice of the already-simulated fixtures, so the roll's intermediate tables
// are exactly what standingsFromFixtures would say at that point in the
// season, not an approximation.
export function standingsThroughGameweek(season, members, throughGameweek) {
  const decided = season.fixtures.filter((fixture) => fixture.gameweek <= throughGameweek);
  return standingsFromFixtures(decided, members);
}

// -- Report card ---------------------------------------------------------------
//
// Every derivation below is a straightforward max/min scan with a strict
// comparison (`>` / `<`, never `>=`/`<=`), so on a tie the earliest-seen
// candidate wins: the lowest gameweek number for bestGameweek, the first
// starter in lineup order for mvp/weakLink, the first opponent encountered in
// fixture order for rival. Documented rather than incidental, so a future
// change that reorders inputs does not silently change tie-breaking.

export function buildDemoReportCard({ humanId, members, season }) {
  const { standings, fixtures, gwPointsByUser, playerSeasonTotals, lineups, rosterById } = season;
  const position = standings.findIndex((row) => row.userId === humanId) + 1;
  const row = standings.find((entry) => entry.userId === humanId) ?? null;

  const gwPoints = gwPointsByUser.get(humanId) ?? [];
  let bestGameweek = null;
  gwPoints.forEach((points, index) => {
    if (bestGameweek == null || points > bestGameweek.points) bestGameweek = { gameweek: index + 1, points };
  });

  const lineup = lineups.get(humanId);
  const totals = playerSeasonTotals.get(humanId) ?? new Map();
  let mvp = null;
  let weakLink = null;
  for (const starter of lineup?.starters ?? []) {
    const player = rosterById.get(starter.playerId);
    if (!player) continue;
    const points = totals.get(starter.playerId) ?? 0;
    if (mvp == null || points > mvp.points) mvp = { player, points };
    if (weakLink == null || points < weakLink.points) weakLink = { player, points };
  }

  const rivalLosses = new Map();
  for (const fixture of fixtures) {
    const isHome = fixture.homeUserId === humanId;
    const isAway = fixture.awayUserId === humanId;
    if (!isHome && !isAway) continue;
    const myScore = isHome ? fixture.homeScore : fixture.awayScore;
    const theirScore = isHome ? fixture.awayScore : fixture.homeScore;
    const opponentId = isHome ? fixture.awayUserId : fixture.homeUserId;
    if (theirScore > myScore) rivalLosses.set(opponentId, (rivalLosses.get(opponentId) ?? 0) + 1);
  }
  let rival = null;
  for (const [opponentId, losses] of rivalLosses) {
    if (rival == null || losses > rival.losses) rival = { userId: opponentId, losses };
  }
  const rivalName = rival ? members.find((member) => member.userId === rival.userId)?.name ?? "Someone" : null;

  return {
    position,
    leagueSize: members.length,
    played: row?.played ?? 0,
    wins: row?.wins ?? 0,
    draws: row?.draws ?? 0,
    losses: row?.losses ?? 0,
    pointsFor: row?.pointsFor ?? 0,
    pointsAgainst: row?.pointsAgainst ?? 0,
    bestGameweek,
    mvp,
    weakLink,
    rival: rival ? { name: rivalName, losses: rival.losses } : null,
  };
}

// One line worth pasting into a group chat: finish, points, MVP, link. Reuses
// fantasyDraft.js's formatOrdinal rather than re-deriving "1st/2nd/3rd..."
export function composeDemoShareText(reportCard, link) {
  const ordinal = formatOrdinal(reportCard.position);
  const mvpBit = reportCard.mvp ? ` MVP: ${reportCard.mvp.player.name}.` : "";
  return (
    `I finished ${ordinal} of ${reportCard.leagueSize} in my Kickoff Draft trial season: ` +
    `${reportCard.pointsFor} pts for, ${reportCard.pointsAgainst} against.${mvpBit} ` +
    `Try it yourself in about 5 minutes: ${link}`
  );
}
