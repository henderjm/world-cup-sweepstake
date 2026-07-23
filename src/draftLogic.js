// Pure snake-draft logic for the fantasy H2H draft room. No DOM, no fetch, no D1,
// no Durable Object APIs: the Worker's FantasyDraftRoom Durable Object (the only
// piece of this feature that cannot run under node:test) is a thin shell around
// these functions, mirroring how src/fantasyScoring.js keeps the scoring formula
// testable outside the Worker.

import { SQUAD_SLOTS } from "./fantasy.js";

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

// Deterministic best-available pick for the pick clock running out. Preference
// order: fill the scarcest unfilled bucket first (fewest slots remaining, ties
// broken by SQUAD_SLOTS key order: GK, DEF, MID, FWD), then the highest-listed
// player for that bucket (first match in `available`, so the pool's own order is
// the "rank"). Returns null only when every unfilled bucket has no legal
// candidate left in `available` (should not happen in practice: the pool is far
// larger than a squad, but a caller must handle it rather than crash).
//
// `available` is assumed to already exclude every player drafted anywhere in the
// league; autoPick only re-checks the position-bucket rule via validatePick.
export function autoPick(available, roster, squadSlots = SQUAD_SLOTS) {
  const counts = countByPosition(roster);
  const scarcity = Object.keys(squadSlots)
    .map((position) => ({ position, remaining: squadSlots[position] - (counts[position] ?? 0) }))
    .filter((entry) => entry.remaining > 0)
    .sort((a, b) => a.remaining - b.remaining); // stable: ties keep squadSlots key order

  const noneDrafted = new Set();
  for (const { position } of scarcity) {
    const candidate = (available ?? []).find((player) => player?.position === position);
    if (!candidate) continue;
    const validation = validatePick({ roster, draftedIds: noneDrafted, player: candidate, squadSlots });
    if (validation.valid) return candidate;
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
