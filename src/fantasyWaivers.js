// Pure free agency / waivers rules engine (Phase 4.4). No DOM, no fetch, no D1:
// the Worker's waiver routes and the gameweek-advance cron are thin shells
// around these functions, mirroring how fantasyGameweek.js and
// fantasyLineups.js keep the same rules unit-tested outside the Worker.
//
// Player state invariant (per league): a player is exactly one of
//   OWNED        on some manager's fantasy_rosters row.
//   ON_WAIVERS   recently dropped, sitting on the wire until the next run.
//   FREE_AGENT   unowned and not on the wire.
//
// The same-position-swap rule is the core roster invariant of this feature:
// SQUAD_SLOTS (GK 2, DEF 5, MID 5, FWD 3) sums to exactly SQUAD_SIZE, so every
// roster bucket is always exactly full. An acquisition can therefore only ever
// be legal alongside a drop from the SAME bucket; there is no such thing as a
// "spare slot" to add into. This is checked on every acquisition path, not
// only at claim-submit time, because resolveWaiverRun re-validates against a
// working copy of state that can have shifted since a claim was queued.

import { SQUAD_SLOTS } from "./fantasy.js";

export const WAIVER_MODES = ["faab", "rolling", "reverse_standings"];
export const DEFAULT_FAAB_BUDGET = 100;

// Classifies one player's availability for a league. `ownedIds`/`wireIds`
// accept a Set or a plain array (the same leniency draftLogic.js's
// draftedIds uses), since callers reach for whichever is already at hand.
export function playerAvailability({ playerId, ownedIds, wireIds } = {}) {
  const owned = ownedIds instanceof Set ? ownedIds.has(playerId) : Boolean(ownedIds?.includes?.(playerId));
  if (owned) return "owned";
  const onWire = wireIds instanceof Set ? wireIds.has(playerId) : Boolean(wireIds?.includes?.(playerId));
  return onWire ? "on_waivers" : "free_agent";
}

// Validates one proposed swap before it is ever written: the instant
// free-agency path calls this synchronously before performing the swap; the
// waiver-claim path calls it before queuing a claim. `path` is "free_agent"
// or "waiver" and picks which availability state is legal for addPlayer (a
// free agent must use the instant route, an on-waivers player must use a
// claim); `availability` is addPlayer's playerAvailability() result;
// `roster` is the claimant's current roster ({ id, position }[]).
export function validateAcquisition({
  addPlayer,
  dropPlayer,
  roster,
  availability,
  path,
  mode,
  bid,
  budgetRemaining,
}) {
  if (!addPlayer || addPlayer.id == null) return { ok: false, error: "No player specified to add" };
  if (!dropPlayer || dropPlayer.id == null) return { ok: false, error: "No player specified to drop" };

  if (path === "free_agent" && availability !== "free_agent") {
    return { ok: false, error: "Player is not a free agent" };
  }
  if (path === "waiver" && availability !== "on_waivers") {
    return { ok: false, error: "Player is not on waivers" };
  }
  if (availability === "owned") return { ok: false, error: "Player is already owned" };

  const ownsAdd = (roster ?? []).some((player) => player.id === addPlayer.id);
  if (ownsAdd) return { ok: false, error: "You already own that player" };

  const ownsDrop = (roster ?? []).some((player) => player.id === dropPlayer.id);
  if (!ownsDrop) return { ok: false, error: "You do not own that player" };

  if (addPlayer.position !== dropPlayer.position) return { ok: false, error: "Positions must match" };

  // Bids only exist on the waiver-claim path: instant free agency is
  // first-come-first-served with no bidding, regardless of the league's mode.
  if (path === "waiver" && mode === "faab") {
    if (!Number.isInteger(bid) || bid < 0) return { ok: false, error: "Bid must be a non-negative whole number" };
    if (bid > (budgetRemaining ?? 0)) return { ok: false, error: "Not enough budget" };
  }

  return { ok: true };
}

// reverse_standings recomputes worst-record-first fresh from the league's
// current table every run (nothing persisted); faab and rolling both read
// the stored per-manager league priority (fantasy_waiver_state.priority),
// faab using it only as a tiebreak, rolling as the primary order.
// `priorities` is [{ userId, priority }]; `standings` is the array
// standingsFromFixtures already produces, best record first.
function leaguePriorityMap(mode, priorities, standings) {
  const map = new Map();
  if (mode === "reverse_standings") {
    const worstFirst = [...(standings ?? [])].reverse();
    worstFirst.forEach((row, index) => map.set(row.userId, index + 1));
    return map;
  }
  (priorities ?? []).forEach((entry) => map.set(entry.userId, entry.priority));
  return map;
}

// Sorts claims into resolution order. Pure and stable: identical input always
// produces the identical order, which resolveWaiverRun's sequential
// processing depends on to be deterministic.
//   faab: highest bid first; ties break by better (lower) league waiver
//     priority, then the claimant's own claim order, then claim id.
//   rolling / reverse_standings: league waiver priority ascending (lower
//     first, worst-record-first for reverse_standings), then the claimant's
//     own claim order, then claim id.
// "The claimant's own claim order" is claim.priority: fantasy_waivers'
// existing priority column, repurposed as the manager's own ranking among
// their own claims (1 = try first), distinct from the league-wide waiver
// priority used for the primary ordering.
export function orderClaims(claims, { mode, priorities, standings } = {}) {
  const list = claims ?? [];
  const leaguePriority = leaguePriorityMap(mode, priorities, standings);

  return [...list].sort((a, b) => {
    if (mode === "faab" && (b.bid ?? 0) !== (a.bid ?? 0)) return (b.bid ?? 0) - (a.bid ?? 0);
    const pa = leaguePriority.get(a.userId) ?? Number.MAX_SAFE_INTEGER;
    const pb = leaguePriority.get(b.userId) ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    const ca = a.priority ?? Number.MAX_SAFE_INTEGER;
    const cb = b.priority ?? Number.MAX_SAFE_INTEGER;
    if (ca !== cb) return ca - cb;
    return a.claimId - b.claimId;
  });
}

// Checks one claim against the run's working state, in the same order the
// rejection vocabulary is documented in: the degenerate add-equals-drop case
// first (this is an engine-level safety net: validateAcquisition already
// blocks it at submission, but the working-state checks below cannot be
// trusted to catch it on their own — a same-player claim trivially owns its
// own "drop", trivially matches its own position, and would otherwise be
// processed and pushed onto wireAdds while the roster write it triggers is a
// no-op, leaving the engine's own ownership bookkeeping out of sync with
// reality), then a taken player (the only other check whose wording depends
// on mode), then ownership of the declared drop, then the position-match
// invariant, then (faab only) the bid against the already-decremented
// remaining budget.
function evaluateClaim({ claim, mode, takenThisRun, workingOwnedBy, workingBudgets, playerLookup }) {
  const { userId, addPlayerId, dropPlayerId, bid } = claim;

  if (addPlayerId === dropPlayerId) {
    return { ok: false, error: "Cannot add and drop the same player" };
  }

  if (takenThisRun.has(addPlayerId)) {
    // Same underlying condition (someone else already won this wire player
    // earlier in this run), but the framing differs by mode: faab feels like
    // losing an auction, rolling/reverse_standings feels like losing a queue.
    return { ok: false, error: mode === "faab" ? "Outbid" : "Player already claimed" };
  }

  if (workingOwnedBy.get(dropPlayerId) !== userId) {
    return { ok: false, error: "You no longer hold that player" };
  }

  const addPosition = playerLookup.get(addPlayerId)?.position;
  const dropPosition = playerLookup.get(dropPlayerId)?.position;
  if (!addPosition || !dropPosition || addPosition !== dropPosition) {
    return { ok: false, error: "Positions must match" };
  }

  if (mode === "faab") {
    const remaining = workingBudgets.get(userId) ?? 0;
    if (!Number.isInteger(bid) || bid < 0 || bid > remaining) {
      return { ok: false, error: "Not enough budget" };
    }
  }

  return { ok: true };
}

// Processes one league's pending claims sequentially against a working copy
// of ownership/budgets, so a later claim in the same run always sees the
// effect of an earlier one. Parameters:
//   claims:     [{ claimId, userId, addPlayerId, dropPlayerId, bid, priority }]
//   mode:       one of WAIVER_MODES
//   rosters:    Map<userId, Set<playerId>>  (accepted for interface symmetry
//               with playerAvailability's callers; every ownership check
//               resolveWaiverRun itself performs goes through the reverse
//               index `ownedBy` instead, so this is not read here)
//   ownedBy:    Map<playerId, userId>       (reverse index, working copy only)
//   budgets:    Map<userId, number>         (faab remaining; ignored otherwise)
//   priorities: [{ userId, priority }]      (league-wide waiver order)
//   standings:  standingsFromFixtures() output, best record first
//   players:    Map<playerId, { position }>
// Returns { results, rosterChanges, budgets, priorities, wireAdds }:
//   results:       one entry per claim, in resolution order, { claimId,
//                  userId, status: "processed" | "rejected", reason,
//                  addPlayerId, dropPlayerId, bid }
//   rosterChanges: [{ userId, addPlayerId, dropPlayerId }] for processed
//                  claims only, in resolution order (what the caller writes
//                  to fantasy_rosters)
//   budgets:       [{ userId, remaining }] after this run's decrements
//   priorities:    [{ userId, priority }] after this run's mode-specific
//                  post-run update (rolling only; unchanged otherwise)
//   wireAdds:      unique player ids to add to the wire (the losers of each
//                  processed swap)
export function resolveWaiverRun({ claims, mode, ownedBy, budgets, priorities, standings, players }) {
  const order = orderClaims(claims, { mode, priorities, standings });

  const workingOwnedBy = new Map(ownedBy ?? []);
  const workingBudgets = new Map(budgets ?? []);
  const playerLookup = players instanceof Map ? players : new Map(Object.entries(players ?? {}));

  const results = [];
  const rosterChanges = [];
  const wireAdds = [];
  const takenThisRun = new Set();
  const winners = new Set();

  for (const claim of order) {
    const { claimId, userId, addPlayerId, dropPlayerId, bid } = claim;
    const outcome = evaluateClaim({ claim, mode, takenThisRun, workingOwnedBy, workingBudgets, playerLookup });

    if (!outcome.ok) {
      results.push({
        claimId,
        userId,
        status: "rejected",
        reason: outcome.error,
        addPlayerId,
        dropPlayerId,
        bid: bid ?? null,
      });
      continue;
    }

    // Apply the swap to the working state before the next claim is judged,
    // so a second claim on the same wire player or the same drop sees it.
    workingOwnedBy.set(addPlayerId, userId);
    workingOwnedBy.delete(dropPlayerId);
    if (mode === "faab") workingBudgets.set(userId, (workingBudgets.get(userId) ?? 0) - (bid ?? 0));
    takenThisRun.add(addPlayerId);
    winners.add(userId);

    results.push({ claimId, userId, status: "processed", reason: null, addPlayerId, dropPlayerId, bid: bid ?? null });
    rosterChanges.push({ userId, addPlayerId, dropPlayerId });
    wireAdds.push(dropPlayerId);
  }

  const nextPriorities = mode === "rolling" ? nextRollingPriorities(priorities, winners) : (priorities ?? []);

  return {
    results,
    rosterChanges,
    budgets: [...workingBudgets.entries()].map(([userId, remaining]) => ({ userId, remaining })),
    priorities: nextPriorities,
    wireAdds: [...new Set(wireAdds)],
  };
}

// rolling's post-run reshuffle: every manager who won at least one claim
// moves to the back of the queue (preserving their relative order among
// winners), everyone else shuffles up (preserving their relative order).
// `priorities` is [{ userId, priority }]; `winnerIds` a Set or array of
// userIds who won at least one claim this run.
export function nextRollingPriorities(priorities, winnerIds) {
  const winners = winnerIds instanceof Set ? winnerIds : new Set(winnerIds ?? []);
  const ordered = [...(priorities ?? [])].sort((a, b) => a.priority - b.priority);
  const stayers = ordered.filter((entry) => !winners.has(entry.userId));
  const movedBack = ordered.filter((entry) => winners.has(entry.userId));
  return [...stayers, ...movedBack].map((entry, index) => ({ userId: entry.userId, priority: index + 1 }));
}
