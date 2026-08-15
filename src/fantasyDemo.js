// Pure logic for the signed-out "try a draft" demo: draft a 15-player squad
// against bots, then play a full 38-gameweek season in 6 chunks with a
// "manager desk" pause between each, and produce a report card. No DOM, no
// fetch, no server. This module deliberately reuses the real rules rather
// than re-deriving them:
//   - src/draftLogic.js: resolvePick/validatePick/autoPick (snake order + the
//     scarcest-bucket-first autopick, the bots' brain) and roundRobinSchedule
//     (the same H2H fixture generator the real league would use).
//   - src/fantasyDraft.js: reduceDraftMessage, the exact pick -> clock message
//     reducer the live WebSocket client applies, so the demo's local draft
//     loop advances identically to a real draft room's state machine.
//   - src/fantasy.js: SQUAD_SIZE/SQUAD_SLOTS.
//   - src/fantasyLineups.js: defaultLineup, repairLineup and
//     validateLineupSelection, the same formation-fill/repair/validation a
//     real manager's lineup edits and roster changes get.
//   - src/fantasyGameweek.js: rosterGameweekPoints (captain doubling) and
//     standingsFromFixtures (win/draw/loss ranking).
//   - src/fantasyWaivers.js: resolveWaiverRun (the real contested-claim
//     resolver: rolling priority order, the same-position-swap invariant,
//     one processed claim per wire player per run) - see the "Waivers"
//     section below for the one deliberate simplification against the real
//     product (documented there, not glossed over).
//   - src/fantasyDemoFixtures.js / src/fantasyDemoPlayerState.js: fixture
//     join + club strength, and seeded injuries/form - genuinely new,
//     demo-only derivations kept in their own pure/tested modules rather than
//     forked copies of anything real.
//   - src/fantasyDemoWaiverBots.js: the bots' waiver-claim brain, mirroring
//     how draftLogic.js's autoPick is the bots' draft-time brain - there is
//     no real "which player should I claim" rule to reuse, a real league's
//     managers always decide that themselves.
// The score generator itself (seededPlayerGameweekPoints) is the one thing
// with nothing to reuse - the real season hasn't been played yet - so it
// stays a seeded synthetic draw, now layered with fixture difficulty, form
// and injury on top rather than standing alone.

import { autoPick, resolvePick, roundRobinSchedule, validatePick } from "./draftLogic.js";
import { SQUAD_SIZE, SQUAD_SLOTS } from "./fantasy.js";
import { formatOrdinal, reduceDraftMessage } from "./fantasyDraft.js";
import { defaultLineup, repairLineup, validateLineupSelection } from "./fantasyLineups.js";
import { rosterGameweekPoints, standingsFromFixtures } from "./fantasyGameweek.js";
import { resolveWaiverRun } from "./fantasyWaivers.js";
import {
  buildFixtureIndex,
  clubFixture,
  deriveClubStrength,
  fixtureDifficultyMultiplier,
} from "./fantasyDemoFixtures.js";
import {
  formMultiplierAt,
  isInjuredAtGameweek,
  playerFormSeries,
  playerInjuryWindows,
  totalInjuredGameweeks,
} from "./fantasyDemoPlayerState.js";
import { chooseBotWaiverClaim } from "./fantasyDemoWaiverBots.js";
import { hashSeed, mulberry32 } from "./seededRandom.js";

// -- Setup ------------------------------------------------------------------

export const DEMO_LEAGUE_SIZES = [4, 6, 8];
export const DEFAULT_DEMO_LEAGUE_SIZE = 6;
// "Your team", not "You": every league surface marks the caller's own row with
// a "(you)" suffix, and a manager literally named "You" rendered as "You (you)".
export const DEFAULT_DEMO_MANAGER_NAME = "Your team";
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
// is a safe no-op. `viaQueue` mirrors the real Durable Object's alarm
// autopick flag (see worker/draftRoom.js and renderPickFeed's badge) so the
// demo's pick feed marks a clock-expiry pick pulled from the human's own
// queue exactly the same way the real product does - the same rule, not a
// look-alike.
export function applyDemoPick(room, player, { viaQueue = false } = {}) {
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
    viaQueue,
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
  return autoPick(available, room.rosters?.[current.userId] ?? [], SQUAD_SLOTS, room.memberIds?.length ?? 1);
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

// -- Seeded per-gameweek score generator -----------------------------------------

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

// One player's BASE fantasy points for one gameweek: deterministic given
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
//
// This is the BASE draw only: fixture difficulty, form and injury are
// layered on top of it by playerGameweekPoints (season simulation section,
// below), never inside this function - kept exported and unchanged in shape
// so it stays independently testable the way it always has been.
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

// -- Season simulation: a stepwise engine, 6 chunks with a desk between each ----
//
// Replaces the old fire-and-forget simulateDemoSeason (which rolled all 38
// gameweeks at once with a fixed lineup, no fixtures, no waivers). The season
// is now a piece of STATE that advances one chunk at a time
// (advanceDemoSeasonChunk), so a human decision made at a desk between chunks
// (a waiver claim, a lineup/captain change) genuinely changes the gameweeks
// that follow. Every mutation below follows the same "clone once, mutate the
// clone freely" idiom fantasyWaivers.js's resolveWaiverRun already uses for
// its own working copies - the returned season is always a new object, the
// one passed in is never touched, so app.js can hold onto an old season
// reference (e.g. for an in-flight animation) without it changing underfoot.

export const DEMO_CHUNK_COUNT = 6;
// The real product's rolling waiver mode (fantasyWaivers.js's WAIVER_MODES):
// chosen over faab/reverse_standings because it needs no bid amounts from
// bots and still exercises real contention (orderClaims' priority order,
// nextRollingPriorities' post-run reshuffle), which is the actual teaching
// point - see the "Waivers" section's header comment for the one thing this
// demo does NOT model from the real system.
export const DEMO_WAIVER_MODE = "rolling";

// Splits `totalGameweeks` into `chunks` nearly-equal pieces (remainder spread
// across the first few), returning the LAST gameweek of each chunk. For the
// default 38/6 that's [7, 14, 20, 26, 32, 38] - a desk appears after chunks
// 1-5 (5 pauses, "roughly 6 decisions" once the pre-draft setup is counted);
// nothing pauses after the final chunk, since the season is over by then.
export function demoChunkBoundaries(totalGameweeks = DEMO_SEASON_GAMEWEEKS, chunks = DEMO_CHUNK_COUNT) {
  const count = Math.max(1, Math.min(chunks, totalGameweeks || 1));
  const base = Math.floor(totalGameweeks / count);
  const remainder = totalGameweeks % count;
  const boundaries = [];
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    cursor += base + (i < remainder ? 1 : 0);
    boundaries.push(cursor);
  }
  return boundaries;
}

export function isDemoSeasonComplete(season) {
  return season.simulatedThrough >= season.gameweeks;
}

// True once every chunk boundary has been played (chunkIndex has advanced
// past the last entry in chunkBoundaries) - the desk after this chunk is the
// report card, not another desk, so callers use this to skip the final
// waiver run (nothing left to spend a claim on).
export function isFinalChunk(season) {
  return season.chunkIndex >= season.chunkBoundaries.length;
}

// Builds the season's starting state right after the draft completes.
// `rosters` is a Map<userId, player[]> (the draft's own output); `pool` is
// the full baked player pool (data/PL/players.json's players array) so
// undrafted players can still be scored for the waiver wire; `matches` and
// `standingsMap` come from the real PL live feed (data/PL/live.json) - both
// are optional, and their absence degrades to the OLD flat scoring (no
// fixture difficulty, no blank gameweeks) rather than silently zeroing every
// score, so a fetch failure never bricks the trial season.
export function initDemoSeason({
  seed,
  members,
  rosters,
  pool = [],
  matches = [],
  standingsMap,
  gameweeks = DEMO_SEASON_GAMEWEEKS,
  chunks = DEMO_CHUNK_COUNT,
}) {
  const memberIds = members.map((member) => member.userId);
  const fixtures = roundRobinSchedule(memberIds, gameweeks);

  const rosterById = new Map();
  const ownedBy = new Map();
  for (const [userId, roster] of rosters.entries()) {
    for (const player of roster ?? []) {
      rosterById.set(player.id, player);
      ownedBy.set(player.id, userId);
    }
  }
  // Every pool player, not just the rostered ones, needs to be scoreable: a
  // free agent's season-to-date total is exactly what ranks the waiver wire.
  for (const player of pool ?? []) {
    if (player?.id != null && !rosterById.has(player.id)) rosterById.set(player.id, player);
  }

  const lineups = new Map(memberIds.map((id) => [id, defaultLineup(rosters.get(id) ?? [])]));

  const hasFixtureData = Array.isArray(matches) && matches.length > 0;
  const fixtureIndex = hasFixtureData ? buildFixtureIndex(matches) : new Map();
  const clubStrength = hasFixtureData ? deriveClubStrength({ standingsMap, players: pool }) : new Map();

  const injuryWindows = new Map();
  const formSeries = new Map();
  const playerPointsByGameweek = new Map();
  for (const player of rosterById.values()) {
    injuryWindows.set(player.id, playerInjuryWindows(seed, player.id, gameweeks));
    formSeries.set(player.id, playerFormSeries(seed, player.id, gameweeks));
    playerPointsByGameweek.set(player.id, []);
  }

  return {
    seed,
    members,
    memberIds,
    gameweeks,
    chunkBoundaries: demoChunkBoundaries(gameweeks, chunks),
    chunkIndex: 0,
    simulatedThrough: 0,
    fixtures,
    hasFixtureData,
    rosterById,
    rosters: new Map(rosters),
    ownedBy,
    lineups,
    priorities: memberIds.map((userId, index) => ({ userId, priority: index + 1 })),
    clubStrength,
    fixtureIndex,
    injuryWindows,
    formSeries,
    gwPointsByUser: new Map(memberIds.map((id) => [id, []])),
    playerSeasonTotals: new Map(memberIds.map((id) => [id, new Map()])),
    seasonPointsByPlayer: new Map(),
    playerPointsByGameweek,
    history: [],
    waiverLog: [],
  };
}

// One player's ACTUAL points for one gameweek: base tier/position draw,
// zeroed outright by an injury or a blank gameweek (a club with no fixture
// that matchday - a real fantasy lesson, surfaced via the returned `blank`
// flag rather than hidden), otherwise scaled by fixture difficulty (home/away
// plus opponent strength) and form. Fixture difficulty and blank gameweeks
// only apply when the season was built with real fixture data
// (season.hasFixtureData) - see initDemoSeason's own comment on why an
// unavailable feed degrades instead of zeroing everyone.
function playerGameweekPoints(season, player, gameweek) {
  const injured = isInjuredAtGameweek(season.injuryWindows.get(player.id), gameweek);
  if (injured) return { points: 0, blank: false, injured: true };

  const formMult = formMultiplierAt(season.formSeries.get(player.id), gameweek);

  if (!season.hasFixtureData) {
    const base = seededPlayerGameweekPoints(season.seed, player.id, gameweek, player.tier, player.position);
    return { points: Math.max(0, Math.round(base * formMult)), blank: false, injured: false };
  }

  const fixture = clubFixture(season.fixtureIndex, player.team, gameweek);
  if (!fixture) return { points: 0, blank: true, injured: false };

  const base = seededPlayerGameweekPoints(season.seed, player.id, gameweek, player.tier, player.position);
  const opponentStrength = season.clubStrength.get(fixture.opponent) ?? null;
  const fixtureMult = fixtureDifficultyMultiplier(opponentStrength, fixture.isHome);
  return { points: Math.max(0, Math.round(base * fixtureMult * formMult)), blank: false, injured: false };
}

// Simulates one gameweek INTO `season` (mutates the working copy the caller
// already cloned - see advanceDemoSeasonChunk) and returns that gameweek's
// Map<playerId, points> for the caller's own news derivation.
function simulateGameweekInto(season, gameweek) {
  const pointsByPlayer = new Map();
  for (const player of season.rosterById.values()) {
    const { points } = playerGameweekPoints(season, player, gameweek);
    pointsByPlayer.set(player.id, points);
    season.seasonPointsByPlayer.set(player.id, (season.seasonPointsByPlayer.get(player.id) ?? 0) + points);
    const series = season.playerPointsByGameweek.get(player.id) ?? [];
    series[gameweek - 1] = points;
    season.playerPointsByGameweek.set(player.id, series);
  }
  for (const userId of season.memberIds) {
    const { points, breakdown } = rosterGameweekPoints(season.lineups.get(userId), pointsByPlayer);
    const gwPoints = season.gwPointsByUser.get(userId);
    gwPoints[gameweek - 1] = points;
    const totals = season.playerSeasonTotals.get(userId);
    for (const entry of breakdown) totals.set(entry.playerId, (totals.get(entry.playerId) ?? 0) + entry.points);
  }
  return pointsByPlayer;
}

function cloneSeasonForMutation(season) {
  return {
    ...season,
    rosters: new Map([...season.rosters].map(([id, roster]) => [id, [...roster]])),
    ownedBy: new Map(season.ownedBy),
    lineups: new Map(season.lineups),
    priorities: season.priorities.map((entry) => ({ ...entry })),
    gwPointsByUser: new Map([...season.gwPointsByUser].map(([id, arr]) => [id, [...arr]])),
    playerSeasonTotals: new Map([...season.playerSeasonTotals].map(([id, totals]) => [id, new Map(totals)])),
    seasonPointsByPlayer: new Map(season.seasonPointsByPlayer),
    playerPointsByGameweek: new Map([...season.playerPointsByGameweek].map(([id, arr]) => [id, [...arr]])),
    history: [...season.history],
    waiverLog: [...season.waiverLog],
  };
}

// News for the manager desk that follows this chunk: injuries newly picked up
// by anyone on the human's OWN roster (the "waiver demand" moment), the
// biggest performers this chunk who are NOT on the human's roster (a "you
// could have had this" prompt toward the wire), and the human's own current
// starters who scored the least this chunk. All three are simple top-3 scans
// over this chunk's own totals, not season-to-date - "since last desk" news,
// not a running leaderboard.
function buildChunkNews(season, { fromGw, toGw, chunkPlayerPoints }) {
  const human = season.members.find((member) => !member.isBot);
  const humanRoster = new Set((season.rosters.get(human?.userId) ?? []).map((player) => player.id));

  const injuries = [];
  for (const [playerId, windows] of season.injuryWindows.entries()) {
    if (!humanRoster.has(playerId)) continue;
    const started = (windows ?? []).find((window) => window.start >= fromGw && window.start <= toGw);
    const player = started ? season.rosterById.get(playerId) : null;
    if (player) injuries.push({ player, start: started.start, end: started.end });
  }

  const chunkTotals = new Map();
  for (const { pointsByPlayer } of chunkPlayerPoints) {
    for (const [playerId, points] of pointsByPlayer.entries()) {
      chunkTotals.set(playerId, (chunkTotals.get(playerId) ?? 0) + points);
    }
  }

  const topEntries = (predicate, sortDescending) =>
    [...chunkTotals.entries()]
      .filter(([playerId]) => predicate(playerId))
      .sort((a, b) => (sortDescending ? b[1] - a[1] || a[0] - b[0] : a[1] - b[1] || a[0] - b[0]))
      .slice(0, 3)
      .map(([playerId, points]) => ({ player: season.rosterById.get(playerId), points }))
      .filter((entry) => entry.player);

  const breakouts = topEntries((playerId) => !humanRoster.has(playerId), true);

  const humanLineup = season.lineups.get(human?.userId);
  const starterIds = new Set((humanLineup?.starters ?? []).map((entry) => entry.playerId));
  const underperformers = topEntries((playerId) => starterIds.has(playerId), false);

  return { fromGw, toGw, injuries, breakouts, underperformers };
}

// Advances the season through the NEXT chunk boundary (all gameweeks since
// simulatedThrough up to the next entry in chunkBoundaries), filling in H2H
// fixture scores as it goes so standingsThroughGameweek keeps working for any
// already-simulated gameweek. No waiver claims happen here - that is a
// separate, explicit step (submitDemoWaiverClaims) the desk calls once the
// human has decided, so the chunk itself always simulates deterministically
// off whatever rosters/lineups were true when it started.
export function advanceDemoSeasonChunk(season) {
  if (isDemoSeasonComplete(season)) return season;
  const next = cloneSeasonForMutation(season);
  const targetGw = next.chunkBoundaries[next.chunkIndex] ?? next.gameweeks;
  const fromGw = next.simulatedThrough + 1;

  const chunkPlayerPoints = [];
  for (let gw = fromGw; gw <= targetGw; gw++) {
    chunkPlayerPoints.push({ gw, pointsByPlayer: simulateGameweekInto(next, gw) });
  }

  next.fixtures = next.fixtures.map((fixture) =>
    fixture.gameweek >= fromGw && fixture.gameweek <= targetGw
      ? {
          ...fixture,
          homeScore: next.gwPointsByUser.get(fixture.homeUserId)[fixture.gameweek - 1],
          awayScore: next.gwPointsByUser.get(fixture.awayUserId)[fixture.gameweek - 1],
        }
      : fixture,
  );

  next.simulatedThrough = targetGw;
  next.chunkIndex += 1;
  next.history = [...next.history, buildChunkNews(next, { fromGw, toGw: targetGw, chunkPlayerPoints })];
  return next;
}

// Standings through gameweek `throughGameweek` only (for the animated roll
// and the desk's "table position" card): re-derives from the same real
// standingsFromFixtures, just fed a smaller slice of whatever fixtures have
// been decided so far, so the roll's intermediate tables are exactly what
// standingsFromFixtures would say at that point in the season, not an
// approximation. A gameweek beyond season.simulatedThrough simply has no
// decided fixtures yet (homeScore/awayScore are undefined), which
// standingsFromFixtures already skips rather than mis-scoring as 0-0.
export function standingsThroughGameweek(season, members, throughGameweek) {
  const decided = season.fixtures.filter((fixture) => fixture.gameweek <= throughGameweek);
  return standingsFromFixtures(decided, members);
}

// A manager's last `lastN` decided results as "W"/"D"/"L", oldest first - the
// desk's form strip. Independent of chunk boundaries: reads straight off
// season.fixtures, so it works for any manager (human or bot) at any point.
export function demoManagerForm(fixtures, userId, throughGameweek, lastN = 5) {
  const decided = (fixtures ?? [])
    .filter(
      (fixture) =>
        fixture.gameweek <= throughGameweek &&
        (fixture.homeUserId === userId || fixture.awayUserId === userId) &&
        fixture.homeScore != null &&
        fixture.awayScore != null,
    )
    .sort((a, b) => a.gameweek - b.gameweek);
  return decided.slice(-lastN).map((fixture) => {
    const isHome = fixture.homeUserId === userId;
    const mine = isHome ? fixture.homeScore : fixture.awayScore;
    const theirs = isHome ? fixture.awayScore : fixture.homeScore;
    if (mine > theirs) return "W";
    if (mine < theirs) return "L";
    return "D";
  });
}

// -- Waivers at the desk ----------------------------------------------------------
//
// One deliberate simplification against the real product, stated plainly per
// the brief: the real system splits an unowned player into FREE_AGENT
// (instant, first-come-first-served add) and ON_WAIVERS (queued, contested,
// resolved by resolveWaiverRun) - see fantasyWaivers.js's header comment. At
// 6-chunk granularity there is no meaningful "instant" path (the human is
// only ever looking at the wire once every several gameweeks anyway), so
// EVERY unowned pool player is treated uniformly as claimable through the
// real contested-claim path. This still reuses resolveWaiverRun's actual
// rules (rolling priority order, one winner per contested player per run, the
// same-position-swap invariant) untouched; it just never exercises the
// separate instant-add code path, which would not teach anything extra at
// this pacing.

// The unowned pool, ranked by season-to-date points (not preseason tier) -
// exactly what the desk's waiver wire shows, and what both the bots' and a
// pre-flight check on the human's own claim read from.
export function availableWaiverPlayers(season) {
  return [...season.rosterById.values()]
    .filter((player) => player?.id != null && !season.ownedBy.has(player.id))
    .sort(
      (a, b) => (season.seasonPointsByPlayer.get(b.id) ?? 0) - (season.seasonPointsByPlayer.get(a.id) ?? 0) || a.id - b.id,
    );
}

// Resolves one waiver run: every bot manager deterministically decides its
// own claim (chooseBotWaiverClaim, at most one per bot), plus the human's own
// claim if they made one, all judged together by the REAL resolveWaiverRun -
// so a bot and the human wanting the same player is genuine contention,
// settled by rolling priority order exactly like a real league. `humanClaim`
// is `{ addPlayerId, dropPlayerId }` or null/omitted (the human can skip a
// desk's waiver window entirely). Returns `{ season, humanResult }`, where
// humanResult is the human's own claim's outcome (`{ status, reason }`) or
// null when they made no claim.
export function submitDemoWaiverClaims(season, { humanId, humanClaim } = {}) {
  const available = availableWaiverPlayers(season);
  const claims = [];
  let claimId = 1;
  for (const member of season.members) {
    if (member.userId === humanId || !member.isBot) continue;
    const decision = chooseBotWaiverClaim({
      roster: season.rosters.get(member.userId) ?? [],
      available,
      pointsByPlayer: season.seasonPointsByPlayer,
    });
    if (decision) {
      claims.push({ claimId: claimId++, userId: member.userId, ...decision, bid: null, priority: 1 });
    }
  }
  if (humanClaim) {
    claims.push({ claimId: claimId++, userId: humanId, ...humanClaim, bid: null, priority: 1 });
  }

  if (!claims.length) return { season, humanResult: null };

  const standings = standingsThroughGameweek(season, season.members, season.simulatedThrough);
  const result = resolveWaiverRun({
    claims,
    mode: DEMO_WAIVER_MODE,
    ownedBy: season.ownedBy,
    priorities: season.priorities,
    standings,
    players: season.rosterById,
  });

  const next = cloneSeasonForMutation(season);
  for (const change of result.rosterChanges) {
    const roster = next.rosters.get(change.userId) ?? [];
    const addedPlayer = next.rosterById.get(change.addPlayerId);
    const remaining = roster.filter((player) => player.id !== change.dropPlayerId);
    next.rosters.set(change.userId, addedPlayer ? [...remaining, addedPlayer] : remaining);
    next.ownedBy.delete(change.dropPlayerId);
    next.ownedBy.set(change.addPlayerId, change.userId);

    // A lineup can outlive a roster change (src/fantasyLineups.js's own
    // invariant): repair it immediately so nobody's XI silently references a
    // player they no longer own.
    const lineup = next.lineups.get(change.userId);
    if (lineup) {
      const repaired = repairLineup(lineup.starters, next.rosters.get(change.userId));
      next.lineups.set(change.userId, { starters: repaired.starters });
    }
  }
  next.priorities = result.priorities;
  next.waiverLog = [
    ...next.waiverLog,
    ...result.results.map((entry) => ({ ...entry, chunkIndex: season.chunkIndex, gameweek: season.simulatedThrough })),
  ];

  const humanResult = humanClaim
    ? (result.results.find((entry) => entry.userId === humanId && entry.addPlayerId === humanClaim.addPlayerId) ?? null)
    : null;

  return { season: next, humanResult };
}

// -- Lineup edits at the desk -----------------------------------------------------

// Validates and saves a proposed starting XI via the REAL validation
// (fantasyLineups.js's validateLineupSelection), never trusting the desk's
// own UI to have gotten the formation legal. `starters` is an array of
// player ids, `captainId` one of them.
export function saveDemoLineup(season, userId, { starters, captainId }) {
  const roster = season.rosters.get(userId) ?? [];
  const validation = validateLineupSelection({ starters, captainId, roster });
  if (!validation.ok) return { ok: false, error: validation.error, season };
  const next = cloneSeasonForMutation(season);
  next.lineups.set(userId, { starters: starters.map((id) => ({ playerId: id, isCaptain: id === captainId })) });
  return { ok: true, error: null, season: next };
}

// "Sim to the end" auto-management ONLY (never applied to a bot, and never to
// a manually-played human - both stay "asleep at the wheel" about injuries by
// design, which is exactly what creates waiver demand for a manager who IS
// paying attention). Swaps any currently-injured starter for the best
// same-position bench player by season-to-date points, so skipping ahead
// doesn't strand the human's XI on a captain injured for the rest of the
// season with nobody managing around it.
export function autoBenchInjured(season, userId, gameweek) {
  const roster = season.rosters.get(userId) ?? [];
  const lineup = season.lineups.get(userId);
  if (!lineup) return season;
  const starterIds = new Set(lineup.starters.map((entry) => entry.playerId));
  const injured = lineup.starters.filter((entry) =>
    isInjuredAtGameweek(season.injuryWindows.get(entry.playerId), gameweek),
  );
  if (!injured.length) return season;

  const byId = new Map(roster.map((player) => [player.id, player]));
  let starters = [...lineup.starters];
  for (const entry of injured) {
    const player = byId.get(entry.playerId);
    if (!player) continue;
    const benchOptions = roster.filter(
      (candidate) => candidate.position === player.position && !starterIds.has(candidate.id),
    );
    const replacement = [...benchOptions].sort(
      (a, b) => (season.seasonPointsByPlayer.get(b.id) ?? 0) - (season.seasonPointsByPlayer.get(a.id) ?? 0),
    )[0];
    if (!replacement) continue;
    starterIds.delete(entry.playerId);
    starterIds.add(replacement.id);
    starters = starters.map((starter) =>
      starter.playerId === entry.playerId ? { playerId: replacement.id, isCaptain: starter.isCaptain } : starter,
    );
  }
  const next = cloneSeasonForMutation(season);
  next.lineups.set(userId, { starters });
  return next;
}

// The "watch" escape hatch (requirement 5): plays out every remaining chunk
// without pausing at a desk. Bots keep claiming exactly as they would
// interactively; the human's own team is auto-managed the same deterministic
// way (chooseBotWaiverClaim treats it as just another roster, plus
// autoBenchInjured so an injured captain doesn't sit dead in the XI for the
// rest of the season) rather than freezing in whatever state it was last
// left in. Synchronous and cheap (6 chunks of pure arithmetic), so app.js
// calls this once and jumps straight to the report card.
export function simulateDemoSeasonToEnd(season, { humanId } = {}) {
  let current = season;
  while (!isDemoSeasonComplete(current)) {
    current = advanceDemoSeasonChunk(current);
    if (isFinalChunk(current)) break;
    current = autoBenchInjured(current, humanId, current.simulatedThrough + 1);
    const humanClaim = chooseBotWaiverClaim({
      roster: current.rosters.get(humanId) ?? [],
      available: availableWaiverPlayers(current),
      pointsByPlayer: current.seasonPointsByPlayer,
    });
    current = submitDemoWaiverClaims(current, { humanId, humanClaim }).season;
  }
  return current;
}

// -- Report card ---------------------------------------------------------------
//
// Every derivation below is a straightforward max/min scan with a strict
// comparison (`>` / `<`, never `>=`/`<=`), so on a tie the earliest-seen
// candidate wins: the lowest gameweek number for bestGameweek, the first
// starter in lineup order for mvp/weakLink, the first opponent encountered in
// fixture order for rival. Documented rather than incidental, so a future
// change that reorders inputs does not silently change tie-breaking.
//
// bestTransfer/worstInjuryLuck are ADDITIVE to the original four facts, and
// both tolerate a minimal hand-built `season` (only the original six fields:
// standings/fixtures/gwPointsByUser/playerSeasonTotals/lineups/rosterById) by
// simply returning null rather than throwing - the season the real engine
// produces always carries the extra fields (waiverLog, playerPointsByGameweek,
// injuryWindows, rosters) they need.

function deriveBestTransfer({ humanId, season }) {
  const log = season?.waiverLog;
  const perGw = season?.playerPointsByGameweek;
  if (!Array.isArray(log) || !(perGw instanceof Map)) return null;
  let best = null;
  for (const entry of log) {
    if (entry.userId !== humanId || entry.status !== "processed") continue;
    const player = season.rosterById?.get(entry.addPlayerId);
    if (!player) continue;
    const series = perGw.get(entry.addPlayerId) ?? [];
    const pointsSinceAcquisition = series
      .slice(entry.gameweek ?? 0)
      .reduce((sum, points) => sum + (points ?? 0), 0);
    if (!best || pointsSinceAcquisition > best.points) best = { player, points: pointsSinceAcquisition };
  }
  return best;
}

function deriveWorstInjuryLuck({ humanId, season }) {
  const injuryWindows = season?.injuryWindows;
  const roster = season?.rosters?.get?.(humanId);
  if (!(injuryWindows instanceof Map) || !roster) return null;
  let worst = null;
  for (const player of roster) {
    const gameweeksMissed = totalInjuredGameweeks(injuryWindows.get(player.id));
    if (!gameweeksMissed) continue;
    if (!worst || gameweeksMissed > worst.gameweeksMissed) worst = { player, gameweeksMissed };
  }
  return worst;
}

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
    bestTransfer: deriveBestTransfer({ humanId, season }),
    worstInjuryLuck: deriveWorstInjuryLuck({ humanId, season }),
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
