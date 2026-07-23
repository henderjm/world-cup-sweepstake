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

import { autoPick, resolvePick, snakePickOrder, validatePick } from "./draftLogic.js";
import { SQUAD_SLOTS } from "./fantasy.js";
import { draftSocketUrl } from "./fantasyApi.js";
import { validateLineupSelection } from "./fantasyLineups.js";

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

// "2.08" style pick label (round, then the pick-in-round zero-padded to two
// digits), used by both the recent-picks feed and the caller's own squad list
// so a pick's position in the draft order is glanceable without cross-referencing
// the overall pick count.
export function formatPickNumber(round, pickInRound) {
  return `${round}.${String(pickInRound).padStart(2, "0")}`;
}

// Season label for the draft status card ("2026/27"), derived from today's date
// rather than any match/league data (the fantasy league itself carries no season
// field): the same July-cutoff heuristic src/views.js's seasonLabel uses for the
// scores model, so the two stay consistent without one depending on the other.
export function currentSeasonLabel(now = new Date()) {
  const year = now.getFullYear();
  const start = now.getMonth() >= 6 ? year : year - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, "0")}`;
}

// Deterministic "what would you draft right now" heuristic for the suggested-pick
// card and the pool's PICK badge: the same autoPick the server falls back to
// when a manager's clock runs out (src/draftLogic.js), applied to the caller's own
// roster against the pool with every drafted player (anywhere in the league)
// removed. Not AI, not a projection: a deterministic scarcest-bucket-first rule,
// reused rather than re-derived so the suggestion never disagrees with what a
// timeout would actually pick for you. Returns null once no legal candidate is
// left (squad complete, or pool exhausted for every open bucket).
export function suggestedPick(availablePlayers, myRoster, draftedIds, squadSlots = SQUAD_SLOTS) {
  const drafted = draftedIds ?? new Set();
  const undrafted = (availablePlayers ?? []).filter((player) => player?.id != null && !drafted.has?.(player.id));
  return autoPick(undrafted, myRoster ?? [], squadSlots);
}

// One-line rationale for the suggested-pick card, walking the exact same
// scarcest-bucket-first path autoPick took rather than inventing a separate
// explanation: names the position bucket (which is, by construction, the
// scarcest one with a legal candidate left, since `player` came from
// suggestedPick above), how many of that bucket's slots remain, and whether the
// pick was ranked by a real xP figure or, absent that, just the pool's own
// listed order - honest either way, never claims a stat the player doesn't have.
export function suggestedPickReason(player, myRoster, squadSlots = SQUAD_SLOTS) {
  if (!player) return "";
  const counts = {};
  for (const owned of myRoster ?? []) {
    const position = owned?.position;
    if (position) counts[position] = (counts[position] ?? 0) + 1;
  }
  const total = squadSlots[player.position] ?? 0;
  const remaining = total - (counts[player.position] ?? 0);
  const stats = normalizePlayerStats(player);
  const basis = stats.xp != null ? `Highest listed expected points for ${player.position}.` : `First available ${player.position} in the pool.`;
  return `Fills your scarcest open slot: ${player.position} (${remaining} of ${total} remaining). ${basis}`;
}

// -- Optional pool-file stat fields (contract) ------------------------------------
//
// The player pool file (data/PL/players.json, and any future per-competition
// equivalent) MAY carry these fields per player, all optional, populated by a
// future stats bake that does not exist yet:
//   avg    number    average fantasy points per gameweek so far, e.g. 5.9
//   form   number[]  recent gameweek points, oldest to newest, e.g. [4, 7, 3, 9, 6];
//                     any finite numbers work - the sparkline scales relative to
//                     this player's own max, so raw point totals or 0-1 fractions
//                     both render correctly
//   xp     number    the scoring model's expected points for the next gameweek
//   adp    number    average draft position across leagues (lower = picked earlier)
//
// None of these exist in the current synthetic pool or the first real bake, so
// every reader (the pool table, the suggested-pick rationale) must go through
// this normalizer and treat a missing field as `null`, rendered as a dim
// placeholder - never a fabricated number.
export function normalizePlayerStats(player) {
  const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const form = Array.isArray(player?.form) ? player.form.filter((value) => typeof value === "number" && Number.isFinite(value)) : [];
  return {
    avg: num(player?.avg),
    form: form.length ? form : null,
    xp: num(player?.xp),
    adp: num(player?.adp),
  };
}

// Normalizes a `form` array (see normalizePlayerStats) into up to 5 most-recent
// sparkline bars, each { height, strong }: height is 0-1 relative to this
// player's own max (so the tallest recent game is always a full bar regardless
// of whether the underlying numbers are 0-1 fractions or raw points), and
// strong marks a bar at or above 60% of that max for the lime accent - a direct
// reading of the real number, never a fabricated "good form" flag.
export function formSparklineBars(form) {
  const values = (form ?? []).slice(-5);
  if (!values.length) return [];
  const max = Math.max(...values, 0.0001);
  return values.map((value) => {
    const height = Math.max(0, Math.min(1, value / max));
    return { height, strong: height >= 0.6 };
  });
}

// "1st"/"2nd"/"3rd"/"4th"... for the on-the-clock card's "you pick Nth in this
// round" context sentence. English ordinal suffix rules (11-13 are always "th").
export function formatOrdinal(n) {
  const value = Math.trunc(n ?? 0);
  const rem100 = value % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
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

// -- Starting-lineup edit helpers (My Team pitch editing) -----------------------
//
// A lineup edit's working copy is { starters: number[11], captainId, bench:
// number[4] } - the same shape the lineup API round-trips (see
// src/fantasyApi.js's getLineup/setLineup), kept client-side while a manager
// swaps players between the pitch and the bench before saving. Swapping one
// starter for one bench player is the only mutation the pitch view offers
// (there is no legal reason to "swap" two starters or two bench players - the
// set is unordered, so that would be a silent no-op); anything else is
// rejected with a plain-English error rather than quietly doing nothing.

// Swaps aId and bId between the starters/bench working copy, re-validating the
// whole resulting XI (not just position counts in isolation) via
// fantasyLineups.js's validateLineupSelection - the same rule the Worker
// enforces on save, reused rather than re-implemented so the UI never allows a
// swap the server would then reject. If the outgoing captain is the player
// being benched, captaincy defaults to the new starting XI's first player (the
// same "first starter chosen" default fantasyLineups.js's defaultLineup uses)
// so a swap can never leave a save with no legal captain; the manager can
// always pick someone else afterwards via "Make captain".
export function swapLineup({ starters, captainId, bench, roster }, aId, bId) {
  const startersList = starters ?? [];
  const benchList = bench ?? [];
  if (aId == null || bId == null || aId === bId) {
    return { ok: false, error: "pick one starter and one bench player to swap" };
  }
  const aIsStarter = startersList.includes(aId);
  const bIsStarter = startersList.includes(bId);
  if (aIsStarter === bIsStarter) {
    return { ok: false, error: "pick one starter and one bench player to swap" };
  }

  const nextStarters = startersList.map((id) => (id === aId ? bId : id === bId ? aId : id));
  const nextBench = benchList.map((id) => (id === aId ? bId : id === bId ? aId : id));
  const nextCaptainId = nextStarters.includes(captainId) ? captainId : nextStarters[0];

  const validation = validateLineupSelection({ starters: nextStarters, captainId: nextCaptainId, roster });
  if (!validation.ok) return { ok: false, error: validation.error };

  return { ok: true, starters: nextStarters, bench: nextBench, captainId: nextCaptainId };
}

// Which ids in the opposite group are legal to swap with `pendingId` right
// now - drives which bench/starter tiles the pitch view dims while a manager
// has one player selected mid-swap. Walks the exact same swapLineup path
// rather than re-deriving the position-count rule, so a tile is only ever
// shown as legal if tapping it would actually succeed. Returns an empty Set
// when nothing is selected.
export function legalSwapTargets({ starters, captainId, bench, roster }, pendingId) {
  const legal = new Set();
  if (pendingId == null) return legal;
  const startersList = starters ?? [];
  const benchList = bench ?? [];
  const isStarter = startersList.includes(pendingId);
  const isBench = benchList.includes(pendingId);
  if (!isStarter && !isBench) return legal;

  const candidates = isStarter ? benchList : startersList;
  for (const candidateId of candidates) {
    const result = swapLineup({ starters: startersList, captainId, bench: benchList, roster }, pendingId, candidateId);
    if (result.ok) legal.add(candidateId);
  }
  return legal;
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
