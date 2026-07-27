// Deterministic bot waiver-wire decisions for the try-a-draft demo. This is
// genuinely new logic - the real product has no "which player should a
// manager claim" rule to reuse, that decision is always a human's - so it
// gets its own small pure module and test file, the same way autoPick
// (draftLogic.js) is the bots' brain during the draft itself. Every claim
// this module PRODUCES is still resolved through the real engine
// (fantasyWaivers.js's resolveWaiverRun), so the invariant this feeds into is
// never re-derived here, only the "who does a bot want" question is.

import { SQUAD_SLOTS } from "./fantasy.js";

// A bot only swaps for a clear upgrade, not a marginal one: without this
// margin a bot would churn its roster over a 1-point season-to-date gap at
// every single desk, which reads as noise rather than a manager reacting to
// real form.
export const BOT_WAIVER_MARGIN = 6;

// Picks the roster's weakest player in `position` by season-to-date points
// (ties broken by id ascending, for determinism); null if the bot has no
// player in that bucket (should not happen given SQUAD_SLOTS, but a caller
// must not crash the desk over a malformed roster).
function weakestInPosition(roster, position, pointsByPlayer) {
  const candidates = (roster ?? []).filter((player) => player.position === position);
  if (!candidates.length) return null;
  return [...candidates].sort(
    (a, b) => (pointsByPlayer.get(a.id) ?? 0) - (pointsByPlayer.get(b.id) ?? 0) || a.id - b.id,
  )[0];
}

// Picks the best available player in `position` by season-to-date points
// (ties broken by id ascending). `available` is already filtered to unowned
// players by the caller.
function bestAvailableInPosition(available, position, pointsByPlayer) {
  const candidates = (available ?? []).filter((player) => player.position === position);
  if (!candidates.length) return null;
  return [...candidates].sort(
    (a, b) => (pointsByPlayer.get(b.id) ?? 0) - (pointsByPlayer.get(a.id) ?? 0) || a.id - b.id,
  )[0];
}

// One bot's claim for this desk, or null if nothing clears the margin in any
// position bucket. Considers every SQUAD_SLOTS position and acts on whichever
// shows the single largest improvement, so a bot never floods the wire with
// one claim per weak position in the same run - one manager, one claim per
// run, the same shape the real product's waiver run resolves against.
export function chooseBotWaiverClaim({ roster, available, pointsByPlayer, margin = BOT_WAIVER_MARGIN }) {
  let best = null;
  for (const position of Object.keys(SQUAD_SLOTS)) {
    const weakest = weakestInPosition(roster, position, pointsByPlayer);
    const candidate = bestAvailableInPosition(available, position, pointsByPlayer);
    if (!weakest || !candidate) continue;
    const improvement = (pointsByPlayer.get(candidate.id) ?? 0) - (pointsByPlayer.get(weakest.id) ?? 0);
    if (improvement <= margin) continue;
    if (!best || improvement > best.improvement) {
      best = { improvement, addPlayer: candidate, dropPlayer: weakest };
    }
  }
  return best ? { addPlayerId: best.addPlayer.id, dropPlayerId: best.dropPlayer.id } : null;
}
