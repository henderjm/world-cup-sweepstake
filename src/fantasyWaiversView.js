// Pure view-layer helpers for the Waivers tab (Phase 4.4): mode copy, priority
// ordinals, claim-list partitioning/name lookups, and the same-position drop-
// candidate filter the roster invariant requires everywhere an acquisition
// happens (see CLAUDE.md and src/fantasyWaivers.js's validateAcquisition,
// which this file stays honest with rather than re-deriving the rule). No
// DOM, no fetch: fantasyView.js renders with these, app.js wires the clicks.

import { formatOrdinal } from "./fantasyDraft.js";

// Short, plain-English label for the mode chip.
const MODE_LABELS = {
  faab: "Blind bidding (FAAB)",
  rolling: "Rolling list",
  reverse_standings: "Reverse standings",
};

export function waiverModeLabel(mode) {
  return MODE_LABELS[mode] ?? mode;
}

// One honest sentence per mode explaining how a winner gets picked, written
// for a manager who has never seen this before. Never claims a mode exists
// beyond the three the league setting actually supports.
const MODE_EXPLANATIONS = {
  faab: "Everyone bids blind from their season budget: the highest bid wins, ties broken by waiver priority.",
  rolling: "Claims are resolved in priority order; whoever wins a claim moves to the back of the queue.",
  reverse_standings: "The worst-placed manager in the league gets first pick each run, recomputed fresh every time.",
};

export function waiverModeExplanation(mode) {
  return MODE_EXPLANATIONS[mode] ?? "";
}

// "3rd of 4" for the rolling/reverse_standings status line. A null priority (a
// manager the league state hasn't seeded yet) or a non-positive total renders
// nothing rather than a nonsensical ordinal.
export function priorityOrdinalLabel(priority, total) {
  if (priority == null || !Number.isFinite(total) || total <= 0) return "";
  return `${formatOrdinal(priority)} of ${total}`;
}

// Roster players sharing addPlayer's position: the only legal drop candidates
// for any acquisition, since SQUAD_SLOTS keeps every bucket always exactly
// full (the same-position-swap invariant). Returns an empty array for a
// missing position rather than the whole roster - offering every player as a
// droppable would be actively wrong, not just unhelpful.
//
// `lockedIds` (a Set, optional) additionally excludes any player whose club
// has already kicked off this gameweek (see src/fantasyLocks.js): dropping
// him after his game has been decided is exactly the exploit the kickoff
// lock closes, so he is never offered as a drop candidate here, mirroring
// the Worker's own check in handleFantasyFreeAgentAdd.
export function dropCandidates(roster, position, lockedIds) {
  if (!position) return [];
  return (roster ?? []).filter((player) => player?.position === position && !lockedIds?.has?.(player?.id));
}

// True only when addPlayer and dropPlayer share a position - the same check
// validateAcquisition performs server-side, mirrored here so the UI can dim
// or explain an illegal pairing before ever submitting it.
export function isLegalDropCandidate(addPlayer, dropPlayer) {
  return Boolean(addPlayer?.position) && addPlayer.position === dropPlayer?.position;
}

// Splits a manager's own claim history (already newest-first from the
// Worker) into still-pending (cancellable) and resolved (history), preserving
// order within each group.
export function partitionWaiverClaims(claims) {
  const pending = [];
  const resolved = [];
  for (const claim of claims ?? []) {
    (claim.status === "pending" ? pending : resolved).push(claim);
  }
  return { pending, resolved };
}

// A player id -> {id,name,team,position} lookup built from whatever the
// waivers view already fetched: free agents, the wire (unwrapping each
// entry's nested `player`) and the caller's own roster (so a claim that has
// already been won and landed on the roster still resolves a name). A player
// id genuinely not covered by any of these falls through to a plain
// "Player #id" placeholder wherever this is read (see fantasyView.js), never
// a blank line.
export function buildWaiverPlayerLookup({ freeAgents, wire, roster } = {}) {
  const map = new Map();
  for (const player of freeAgents ?? []) if (player?.id != null) map.set(player.id, player);
  for (const entry of wire ?? []) if (entry?.player?.id != null) map.set(entry.player.id, entry.player);
  for (const player of roster ?? []) if (player?.id != null) map.set(player.id, player);
  return map;
}

// Plain-English label for a claim's status. "pending" is included for
// completeness even though the view gives a pending claim a Cancel button
// rather than this label.
const CLAIM_STATUS_LABELS = { processed: "Won", rejected: "Rejected", pending: "Pending" };

export function claimStatusLabel(status) {
  return CLAIM_STATUS_LABELS[status] ?? status;
}
