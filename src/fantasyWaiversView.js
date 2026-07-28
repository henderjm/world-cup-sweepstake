// Pure view-layer helpers for the Waivers tab (Phase 4.4): mode copy, priority
// ordinals, claim-list partitioning/name lookups, and the same-position drop-
// candidate filter the roster invariant requires everywhere an acquisition
// happens (see CLAUDE.md and src/fantasyWaivers.js's validateAcquisition,
// which this file stays honest with rather than re-deriving the rule). No
// DOM, no fetch: fantasyView.js renders with these, app.js wires the clicks.

import { formatOrdinal, normalizePlayerStats } from "./fantasyDraft.js";

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

// Which run a claim submitted right now would land in, said out loud. A claim
// must never be ambiguous about which run it belongs to, and the quiet period
// before a run (WAIVER_QUIET_PERIOD_MS in fantasyWaivers.js) is exactly the
// window where a manager would otherwise assume the wrong one: the claim is
// still accepted, but it is deferred, and being told that is the whole reason
// deferring beats silently including it or silently rejecting it.
export function claimWindowNote(claimWindow) {
  const gameweek = claimWindow?.gameweek;
  if (!Number.isFinite(gameweek)) return "";
  if (claimWindow.deferred) {
    return `Gameweek ${gameweek - 1}'s run is closing. A claim submitted now is queued for the gameweek ${gameweek} run instead.`;
  }
  return `A claim submitted now is resolved by the gameweek ${gameweek} run.`;
}

// Everything a free-agent ROW needs to show its three decision numbers, built
// once and shared by the full panel render and the filter-keystroke repaint
// (refreshFantasyFreeAgentRows in app.js). Built here rather than inline in
// either caller because the two must agree: a manager typing in the search box
// must not watch the xP column change basis or disappear.
//
// `starters` is the caller's real XI with each starter's xP attached, and it is
// EMPTY unless a lineup has actually been loaded. That is deliberate: the
// upgrade figure is defined against the manager's own worst starter, so with no
// lineup there is no honest comparison to make and every upgrade comes back
// null rather than being quietly computed against something else.
export function buildFreeAgentContext({ waivers, roster, playerPool, lineup, xpStats } = {}) {
  const statsById = new Map((playerPool ?? []).map((player) => [player.id, player]));
  const rosterById = new Map((roster ?? []).map((player) => [player.id, player]));

  const starters = (lineup?.starters ?? [])
    .map((entry) => {
      const player = rosterById.get(entry.playerId);
      if (!player) return null;
      return { position: player.position, xp: normalizePlayerStats(statsById.get(player.id) ?? {}).xp };
    })
    .filter(Boolean);

  return {
    statsById,
    starters,
    // The Worker sends season points as a plain object (JSON has no Map), so
    // the keys arrive as strings and have to be coerced back to the numeric
    // player ids every other lookup here uses.
    seasonPoints: new Map(Object.entries(waivers?.seasonPoints ?? {}).map(([id, points]) => [Number(id), points])),
    xpStats,
    preseason: Boolean(waivers?.preseason),
    // Carried separately from `preseason` because BOTH can be true at once, in
    // the two hours between gameweek 1's deadline and the opening kickoff. The
    // panel's lock sentence has to follow the lock, or it ends up telling a
    // manager nothing is locked directly above fifteen rows marked Locked.
    squadLocked: Boolean(waivers?.squadLocked),
  };
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
