// Fantasy draft room: the pure UI-facing logic (countdown formatting, legal-pick
// derivation, squad bucket counts) plus the stateful WebSocket loop that keeps a
// local copy of the live draft in sync with the Worker's FantasyDraftRoom Durable
// Object. Mirrors src/paperRunGame.js: pure functions are unit-tested directly,
// the socket/timer plumbing below them is DOM-only and exercised by hand.
//
// The pure functions reuse src/draftLogic.js (snakePickOrder, resolvePick,
// validatePick) rather than re-deriving snake order or the position-bucket rule:
// that module is already the tested, shared source of truth the Worker's Durable
// Object relies on, so the client must agree with it exactly rather than keep a
// second copy that could drift.

import { resolvePick, snakePickOrder, validatePick } from "./draftLogic.js";
import { SQUAD_SLOTS } from "./fantasy.js";
import { draftSocketUrl } from "./fantasyApi.js";

// -- Pure logic ----------------------------------------------------------------

// "0:45" / "1:00" style, clamped at zero so a message arriving a beat late never
// shows a negative countdown.
export function formatCountdown(remainingMs) {
  const totalSeconds = Math.max(0, Math.ceil((remainingMs ?? 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// Per-bucket { filled, total } against SQUAD_SLOTS, for the my-squad panel.
export function squadBucketCounts(roster, squadSlots = SQUAD_SLOTS) {
  const counts = {};
  for (const position of Object.keys(squadSlots)) counts[position] = 0;
  for (const player of roster ?? []) {
    const position = player?.position;
    if (position in counts) counts[position] += 1;
  }
  return Object.fromEntries(
    Object.keys(squadSlots).map((position) => [position, { filled: counts[position], total: squadSlots[position] }]),
  );
}

// Whether the Draft button should be live for this player right now: it must be
// my turn, and the pick must pass the shared validatePick rule (not already
// drafted anywhere in the league, my bucket for this position not full).
export function canDraftPlayer(player, { isMyTurn, myRoster, draftedIds, squadSlots = SQUAD_SLOTS } = {}) {
  if (!isMyTurn || !player || player.id == null) return false;
  const validation = validatePick({ roster: myRoster, draftedIds: draftedIds ?? new Set(), player, squadSlots });
  return validation.valid;
}

// The order strip for the round currently on the clock, each entry flagged
// on-clock / next so the view can highlight them. "Next" is resolved from the
// actual next overall pick number rather than an index in `order`, since a pick
// at the end of a round hands off into the reversed order of the following
// round (snake draft), not the next slot in this round's array.
export function draftOrderEntries(memberIds, round, onClockUserId, overallPick) {
  const order = snakePickOrder(memberIds, round);
  const next = resolvePick(memberIds, (overallPick ?? 0) + 1, Infinity);
  return order.map((userId) => ({
    userId,
    isOnClock: userId === onClockUserId,
    isNext: userId === next?.userId && userId !== onClockUserId,
  }));
}

// Pure reducer from the locally-cached room state (null until the first "state"
// message arrives) plus one server message to the next room state. No side
// effects: closing the socket on a "complete" message, or logging an "error"
// message, are the caller's job (see app.js's applyFantasyDraftMessage).
//
// Two behaviors folded in here on purpose rather than left to the caller:
//  - a "pick" message nulls onClockUserId until the paired "clock" message
//    names the next manager, so the Draft buttons go dark for that gap instead
//    of staying lit for the manager who just moved (the server would reject a
//    pick there anyway; this just removes the misleading affordance).
//  - an "error" message is stashed as lastError for the view to surface, and
//    cleared by the next "pick" or "clock" (or a fresh "state" resync) so a
//    stale notice never lingers once the draft has moved on.
export function reduceDraftMessage(roomState, message) {
  if (!message) return roomState;

  if (message.type === "state") {
    return { ...message, lastError: null };
  }

  if (!roomState) return roomState; // no baseline yet; ignore anything before "state"

  switch (message.type) {
    case "pick":
      return {
        ...roomState,
        picks: [
          ...roomState.picks,
          {
            round: message.round,
            pickInRound: message.pickInRound,
            overallPick: message.overallPick,
            userId: message.userId,
            player: message.player,
          },
        ],
        rosters: {
          ...roomState.rosters,
          [message.userId]: [...(roomState.rosters?.[message.userId] ?? []), message.player],
        },
        overallPick: message.overallPick + 1,
        onClockUserId: null,
        lastError: null,
      };
    case "clock":
      return {
        ...roomState,
        onClockUserId: message.onClockUserId,
        overallPick: message.overallPick,
        round: message.round,
        pickInRound: message.pickInRound,
        lastError: null,
      };
    case "complete":
      return { ...roomState, status: "complete" };
    case "error":
      return { ...roomState, lastError: message.error };
    default:
      return roomState;
  }
}

// -- Stateful WebSocket loop -----------------------------------------------------

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

// Opens the draft room socket and keeps calling back with server messages and a
// locally-driven 1-second countdown. Returns { sendPick(playerId), close() }.
// The server replays full state on every connect (see draftRoom.js sendState),
// so a dropped socket just reconnects with backoff and picks up where it left
// off; nothing here needs to resume from a partial local snapshot.
export function openDraftRoom(leagueId, { onMessage, onTick, onSocketError } = {}) {
  let ws = null;
  let reconnectTimer = null;
  let tickTimer = null;
  let deadline = null;
  let closedByCaller = false;
  // Set once a "complete" message is actually received. The server closes the
  // socket with a normal code (1000) once the draft finishes, which looks
  // identical to a dropped connection to the native "close" event; without this
  // flag scheduleReconnect would keep retrying forever while the user sits on
  // the "Draft complete" screen. app.js also closes the socket explicitly on
  // "complete" (the normal teardown path), but that is a second, independent
  // layer - this flag is what actually stops the reconnect loop regardless of
  // whether that call happens to run.
  let terminal = false;
  let attempt = 0;

  function startTicking() {
    stopTicking();
    tickTimer = window.setInterval(() => {
      if (deadline == null) return;
      onTick?.(Math.max(0, deadline - Date.now()));
    }, 1000);
  }

  function stopTicking() {
    if (tickTimer) window.clearInterval(tickTimer);
    tickTimer = null;
  }

  function scheduleReconnect() {
    if (closedByCaller || terminal) return;
    attempt += 1;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
    reconnectTimer = window.setTimeout(connect, delay);
  }

  function connect() {
    const url = draftSocketUrl(leagueId);
    if (!url) {
      onSocketError?.(new Error("no session or worker configured"));
      return;
    }
    try {
      ws = new WebSocket(url);
    } catch (error) {
      onSocketError?.(error);
      scheduleReconnect();
      return;
    }
    ws.addEventListener("open", () => {
      attempt = 0;
    });
    ws.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "clock") {
        deadline = message.deadline;
        startTicking();
        onTick?.(Math.max(0, deadline - Date.now()));
      } else if (message.type === "complete") {
        terminal = true;
        stopTicking();
        deadline = null;
      }
      onMessage?.(message);
    });
    ws.addEventListener("close", () => {
      ws = null;
      stopTicking();
      scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      try {
        ws?.close();
      } catch {
        // already closing
      }
    });
  }

  connect();

  return {
    sendPick(playerId) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "pick", playerId }));
      }
    },
    close() {
      closedByCaller = true;
      stopTicking();
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      try {
        ws?.close();
      } catch {
        // already closed/closing
      }
      ws = null;
    },
  };
}
