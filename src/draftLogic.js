// Pure snake-draft logic for the fantasy H2H draft room. No DOM, no fetch, no D1,
// no Durable Object APIs: the Worker's FantasyDraftRoom Durable Object (the only
// piece of this feature that cannot run under node:test) is a thin shell around
// these functions, mirroring how src/fantasyScoring.js keeps the scoring formula
// testable outside the Worker.

import { SQUAD_SLOTS } from "./fantasy.js";
import { rankDraftPool } from "./fantasyDraftRank.js";

// Snake order: odd rounds (1-based) draft in the given member order, even rounds
// reverse it, so the last picker in round 1 picks first in round 2.
export function snakePickOrder(memberIds, round) {
  const order = [...memberIds];
  return round % 2 === 0 ? order.reverse() : order;
}

// Resolves a 1-based overall pick number to { round, pickInRound, userId } for a
// snake draft over `memberIds.length` managers. Returns null for a pick number
// outside 1..memberIds.length * roundsTotal (the caller decides roundsTotal,
// typically SQUAD_SIZE), or when there are no members to draft with.
export function resolvePick(memberIds, overallPick, roundsTotal = Infinity) {
  const size = memberIds.length;
  if (!size || !Number.isInteger(overallPick) || overallPick < 1) return null;
  const round = Math.ceil(overallPick / size);
  if (round > roundsTotal) return null;
  const pickInRound = overallPick - (round - 1) * size;
  const order = snakePickOrder(memberIds, round);
  return { round, pickInRound, userId: order[pickInRound - 1] };
}

// Per-bucket count of an in-progress roster. Entries may be bare position
// strings or { position } objects, matching validateFormation's leniency.
function countByPosition(roster) {
  const counts = {};
  for (const entry of roster ?? []) {
    const position = typeof entry === "string" ? entry : entry?.position;
    if (!position) continue;
    counts[position] = (counts[position] ?? 0) + 1;
  }
  return counts;
}

// HOW a pick came to be made, recorded on every row of the append-only pick log.
//
// Without this the two drafts that matter most to tell apart are byte-for-byte
// identical in D1: one where every manager showed up, and one where three of
// four sleepwalked through on the clock. "Did the draft happen" was answerable
// and "did the draft WORK" was not, which is the only question worth asking of
// a product whose completed-draft count is zero.
//
// The four values are exhaustive over the two independent facts the draft room
// already knows at commit time (was this manager a bot, and did the pick come
// from a socket message or from the clock alarm):
//
//   manual   a human sent a pick message. Somebody was at the keyboard.
//   queue    a human's clock expired and their OWN shortlist supplied the pick.
//            Engaged with the product, absent from the room. A real middle
//            state, and the reason a boolean here would not have been enough.
//   autopick a human's clock expired with nothing legal in their queue, so the
//            generic scarcest-bucket heuristic chose. Nobody chose this player.
//   bot      a bot manager's seat. Its clock ALWAYS expires by design, so this
//            is never a signal about engagement and must not be counted as
//            one - a bot-filled league would otherwise read as a league full
//            of absentees.
export const PICK_VIA = Object.freeze({
  MANUAL: "manual",
  QUEUE: "queue",
  AUTOPICK: "autopick",
  BOT: "bot",
});

// The one place the taxonomy above is decided, so the socket path and the alarm
// path cannot drift into disagreeing about what a pick was.
//
// A bot outranks the queue/autopick split deliberately. A bot cannot hold a
// draft queue at all (it has no session, by construction - see
// isRealGoogleSub in src/fantasyBots.js - and the queue route writes only
// user.id from a session), so there is no mechanism detail being discarded
// here; what "bot" buys instead is that no bot seat can ever be mistaken for
// an absent human.
export function resolvePickVia({ onClockIsBot = false, fromClock = false, fromQueue = false } = {}) {
  if (onClockIsBot) return PICK_VIA.BOT;
  if (!fromClock) return PICK_VIA.MANUAL;
  return fromQueue ? PICK_VIA.QUEUE : PICK_VIA.AUTOPICK;
}

// D1 surfaces a UNIQUE constraint violation as a rejected promise whose message
// names the failure; there is no distinct error class to catch. Pulled out as a
// pure predicate so the Durable Object's lost-race handling (a D1-level backstop
// for a race blockConcurrencyWhile should already prevent within one instance) is
// testable without a real D1 binding.
export function isUniqueConstraintError(error) {
  return /unique constraint/i.test(error?.message ?? "");
}

// Rejects a pick in two cases: the player is already drafted somewhere in the
// league (draftedIds, a Set or array of player ids), or the picking manager's
// bucket for this player's position is already at its SQUAD_SLOTS cap (the
// simplest correct unfillable-slots rule: a full bucket can never be undone by a
// later pick, so refusing it here is equivalent to checking every future
// combination).
export function validatePick({ roster, draftedIds, player, squadSlots = SQUAD_SLOTS }) {
  if (!player || player.id == null) return { valid: false, error: "no player specified" };

  const alreadyDrafted =
    draftedIds instanceof Set ? draftedIds.has(player.id) : Boolean(draftedIds?.includes?.(player.id));
  if (alreadyDrafted) return { valid: false, error: "player already drafted" };

  const position = player.position;
  if (!squadSlots[position]) return { valid: false, error: `unknown position: ${position}` };

  const counts = countByPosition(roster);
  if ((counts[position] ?? 0) >= squadSlots[position]) {
    return { valid: false, error: `${position} slots are full` };
  }
  return { valid: true, error: null };
}

// Deterministic best-available pick for the pick clock running out: the
// highest-ranked player on the SAME board the draft room showed the manager
// (rankDraftPool, value over replacement) whose position bucket is not already
// full. Returns null only when no unfilled bucket has a legal candidate left in
// `available` (should not happen in practice: the pool is far larger than a
// squad, but a caller must handle it rather than crash).
//
// This used to fill the SCARCEST unfilled bucket first (fewest slots remaining,
// ties broken by SQUAD_SLOTS key order), taking the first listed player for it.
// Both halves of that were wrong and they compounded. GK has the fewest slots
// (2), so an empty roster always ranked GK as scarcest and EVERY manager's first
// two picks were goalkeepers: an all-bot 8-manager draft opened with 16 straight
// keepers and left Haaland on the board until pick 18. And "first listed" meant
// the baked players.json array order, which is grouped by club and sorted only
// by tier (see sortPlayerPool in fantasyPlayerTier.js), so the rest of the squad
// came out as most of whichever club happens to be listed first. The same rule
// drives the suggested-pick card, so managers were being advised to open with a
// keeper too.
//
// Scarcity needs no special handling: SQUAD_SLOTS sums to exactly SQUAD_SIZE, so
// a manager's unfilled slots always equal their remaining picks, and any pick
// into a non-full bucket therefore keeps a legal squad reachable. Positions fill
// themselves late by becoming the only legal buckets left, which is what a
// real autodraft does - take value early, fill the thin buckets last.
//
// `available` is assumed to already exclude every player drafted anywhere in the
// league; autoPick only re-checks the position-bucket rule via validatePick.
// Ranking happens HERE rather than being assumed of the caller's array order,
// because that assumption is exactly what broke: three separate call sites (the
// Durable Object alarm, the demo, and the suggested-pick card) each passed the
// raw pool and none of them passed a ranked one. `leagueSize` only affects
// replacement level, so it changes the cross-position ordering, never legality.
export function autoPick(available, roster, squadSlots = SQUAD_SLOTS, leagueSize = 1) {
  const pool = available ?? [];
  const byId = new Map(pool.map((player) => [player?.id, player]));
  const noneDrafted = new Set();

  for (const candidate of rankDraftPool(pool, leagueSize, squadSlots)) {
    // rankDraftPool returns annotated COPIES; hand back the caller's own object
    // so pick identity survives (commitPick stores what it is given).
    const player = byId.get(candidate?.id) ?? candidate;
    if (validatePick({ roster, draftedIds: noneDrafted, player, squadSlots }).valid) return player;
  }
  return null;
}

// The best pick from a manager's own queue (an ordered array of player ids -
// see src/fantasyDraft.js's addToQueue/toggleQueue/moveQueueItem) right now:
// the first entry (in queue order) that is both still available AND still a
// legal pick against `roster` (its position bucket not already full) - a
// taken player, or one whose bucket has since filled up from other picks, is
// skipped rather than offered. Returns null once nothing in the queue clears
// both bars, so the caller falls back to the generic scarcest-bucket autoPick
// above.
//
// Lives here (not fantasyDraft.js, where it originated) so the server-side
// FantasyDraftRoom Durable Object can consult a manager's own queue for its
// alarm autopick without importing any browser-only module: fantasyDraft.js
// pulls in fantasyApi.js (fetch/WebSocket) and fantasyLineups.js, neither of
// which can run in the Durable Object. fantasyDraft.js re-exports this
// unchanged so its existing callers/tests keep working without modification.
export function topQueuedPick(queue, playerPool, roster, draftedIds, squadSlots = SQUAD_SLOTS) {
  const byId = new Map((playerPool ?? []).map((player) => [player.id, player]));
  const drafted = draftedIds ?? new Set();
  for (const playerId of queue ?? []) {
    if (drafted.has(playerId)) continue;
    const player = byId.get(playerId);
    if (!player) continue;
    const validation = validatePick({ roster, draftedIds: drafted, player, squadSlots });
    if (validation.valid) return player;
  }
  return null;
}

// Round-robin H2H schedule via the circle method: fix the first id, rotate the
// rest by one each round. One cycle covers every pair exactly once in
// memberIds.length - 1 rounds (or memberIds.length rounds with a bye if the
// count is odd, the bye slot represented as null and simply dropped from that
// round's fixtures). The cycle then repeats, with home/away flipped on odd
// repeats, until `gameweeks` is filled.
export function roundRobinSchedule(memberIds, gameweeks = 38) {
  if (memberIds.length < 2) return [];

  const ids = [...memberIds];
  if (ids.length % 2 !== 0) ids.push(null); // bye placeholder, evens out the rotation
  const n = ids.length;
  const roundsPerCycle = n - 1;
  const half = n / 2;

  const cycle = [];
  let arr = ids.slice();
  for (let round = 0; round < roundsPerCycle; round++) {
    const pairs = [];
    for (let i = 0; i < half; i++) {
      const a = arr[i];
      const b = arr[n - 1 - i];
      if (a != null && b != null) pairs.push([a, b]);
    }
    cycle.push(pairs);
    const fixed = arr[0];
    const rest = arr.slice(1);
    arr = [fixed, rest[rest.length - 1], ...rest.slice(0, rest.length - 1)];
  }

  const fixtures = [];
  for (let gw = 1; gw <= gameweeks; gw++) {
    const cycleIndex = Math.floor((gw - 1) / roundsPerCycle);
    const roundIndex = (gw - 1) % roundsPerCycle;
    const flip = cycleIndex % 2 === 1; // alternate venues across cycle repeats
    for (const [a, b] of cycle[roundIndex]) {
      const [home, away] = flip ? [b, a] : [a, b];
      fixtures.push({ gameweek: gw, homeUserId: home, awayUserId: away });
    }
  }
  return fixtures;
}
