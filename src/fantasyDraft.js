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

// topQueuedPick moved to draftLogic.js (the Durable Object needs it and
// cannot import this module - see the comment there); re-exported unchanged
// so every existing caller/test here keeps working without modification.
export { topQueuedPick } from "./draftLogic.js";

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
// removed. Not AI, not a projection: the best player left on the manager's own
// board whose position bucket is still open, reused rather than re-derived so
// the suggestion never disagrees with what a timeout would actually pick for
// you. Returns null once no legal candidate is left (squad complete, or pool
// exhausted for every open bucket).
//
// `leagueSize` reaches autoPick's ranking, so passing it wrong only mis-ranks
// the suggestion, never makes it illegal; it defaults the same way autoPick
// does. It sits ahead of `squadSlots` because callers genuinely vary it, while
// squadSlots is only ever overridden by tests.
export function suggestedPick(availablePlayers, myRoster, draftedIds, leagueSize = 1, squadSlots = SQUAD_SLOTS) {
  const drafted = draftedIds ?? new Set();
  const undrafted = (availablePlayers ?? []).filter((player) => player?.id != null && !drafted.has?.(player.id));
  return autoPick(undrafted, myRoster ?? [], squadSlots, leagueSize);
}

// One-line rationale for the suggested-pick card, walking the exact same path
// autoPick took rather than inventing a separate explanation: the best player
// left on the board with an open bucket, how many of that bucket's slots remain,
// and whether the ranking rested on a real xP figure or, absent that, just the
// pool's own listed order - honest either way, never claims a stat the player
// doesn't have.
//
// It used to open "Fills your scarcest open slot", which was true of the old
// scarcest-bucket-first rule and is why every manager's first suggestion was a
// goalkeeper. Reworded with the rule itself rather than left to describe
// behaviour that no longer happens.
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
  const basis =
    stats.xp != null
      ? `Best value over replacement left on your board.`
      : `First available ${player.position} in the pool.`;
  return `${basis} Fills ${player.position} (${remaining} of ${total} remaining).`;
}

// -- Pick queue (personal shortlist) -----------------------------------------
//
// A manager's own ordered shortlist, built before and during the draft by
// starring players in the pool. Purely client-side: an ordered array of
// player ids, never sent to the server and never affecting anyone else's
// draft (that's exactly why it lives in app.js's state.fantasy.queue /
// state.demo.queue rather than anywhere near draftRoom.js's D1-backed pick
// log). Every function here is a plain array-in, array-out transform so the
// queue's ordering/legality rules are unit-testable without any DOM or state.

// Appends a player if not already queued; re-adding an already-queued player
// is a no-op (returns the same array reference) rather than moving it to the
// back, since "toggle" (see toggleQueue below) is how a manager removes one.
export function addToQueue(queue, playerId) {
  const list = queue ?? [];
  if (playerId == null || list.includes(playerId)) return list;
  return [...list, playerId];
}

export function removeFromQueue(queue, playerId) {
  return (queue ?? []).filter((id) => id !== playerId);
}

// Adds if absent, removes if present - the single action a pool row's queue
// star (or the queue card's own remove button) drives.
export function toggleQueue(queue, playerId) {
  const list = queue ?? [];
  return list.includes(playerId) ? removeFromQueue(list, playerId) : addToQueue(list, playerId);
}

// Moves one entry one slot toward the front ("up") or back ("down") the
// queue order. Moving past either end, or an id no longer in the queue, is a
// no-op (returns the same array reference) rather than wrapping or throwing,
// so a caller can safely disable the button at the edges without a special
// case, and a stale click after the entry was already removed does nothing.
export function moveQueueItem(queue, playerId, direction) {
  const list = queue ?? [];
  const index = list.indexOf(playerId);
  if (index === -1) return list;
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= list.length) return list;
  const next = [...list];
  [next[index], next[swapWith]] = [next[swapWith], next[index]];
  return next;
}

// The queue in display order, each id resolved to its player object (or null
// if it's no longer in the pool - shouldn't happen, but never crash a
// renderer over it) plus whether it's still available (not drafted by
// anyone in the league). Lets the queue card show a taken player struck
// through/marked "Gone" rather than silently vanishing, so a manager can see
// what they lost and clear it deliberately rather than wonder where it went.
export function queueEntries(queue, playerPool, draftedIds) {
  const byId = new Map((playerPool ?? []).map((player) => [player.id, player]));
  const drafted = draftedIds ?? new Set();
  return (queue ?? []).map((playerId) => ({
    playerId,
    player: byId.get(playerId) ?? null,
    available: !drafted.has(playerId),
  }));
}

// Drops from the queue any player the manager now owns. A queued player who
// was sniped by a rival deliberately stays (marked unavailable, see
// queueEntries above) so the manager can see what they lost, but one they
// actually drafted is just noise - the shortlist is "who I still want", and
// leaving a signing sitting there tagged as gone reads like a loss.
// Idempotent, and returns the same array reference when nothing changed so a
// caller can assign the result back unconditionally without churning renders.
export function pruneQueue(queue, myRoster) {
  const list = queue ?? [];
  const mine = new Set((myRoster ?? []).map((player) => player.id));
  if (!list.some((playerId) => mine.has(playerId))) return list;
  return list.filter((playerId) => !mine.has(playerId));
}

// -- Optional pool-file stat field (contract) --------------------------------
//
// avg/form/adp used to live here too: speculative columns designed against a
// future stats bake that never happened. data/PL/players.json's real
// enrichment (appearances/minutes/tier from last season - see
// src/fantasyPlayerTier.js and hasPriorSeasonData/tierLabel below) replaced
// them in the pool table, the player drawer and the lobby scouting list, so
// those three fields and the form sparkline that rendered them are gone
// rather than kept around as dead code.
//
// xp is the one field from that original contract still worth carrying: the
// My Team pitch/bench/Squad xP panels read it (a season-scoring feature,
// unrelated to the prior-season appearance data above), and it stays a
// genuinely optional, future field until a real expected-points bake exists.
// A missing xp is `null`, rendered as a dim placeholder - never a fabricated
// number.
export function normalizePlayerStats(player) {
  const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const xp = num(player?.xp);
  // A basis is only ever attached to a real number: a stray xpBasis string on
  // a player whose xp itself failed to parse would attribute a figure that
  // doesn't exist.
  const xpBasis = xp == null ? null : typeof player?.xpBasis === "string" ? player.xpBasis : null;
  return { xp, xpBasis };
}

// Overlays the Worker's in-season-blended xp/xpBasis (GET
// /fantasy/players/xp, see worker/worker.js's runScheduledFantasyXpBlend)
// onto the static pool's own baked figures, keyed by player id. `blended` is
// the raw `{ [id]: { xp, xpBasis } }` map that route returns, or null/undefined
// when the fetch never happened or failed - in which case the pool passes
// through completely unchanged, since the Worker figure is purely an upgrade
// once any gameweek has actually completed, never a requirement. A player id
// absent from `blended`, or present with a null xp, also keeps the pool's own
// value: the blend only ever replaces a figure it actually has a fresher
// answer for. Returns a NEW array (never mutates `players`).
export function applyBlendedXp(players, blended) {
  if (!blended) return players ?? [];
  return (players ?? []).map((player) => {
    const entry = blended[player.id];
    if (!entry || entry.xp == null) return player;
    return { ...player, xp: entry.xp, xpBasis: entry.xpBasis ?? player.xpBasis ?? null };
  });
}

// Tooltip/title text for an xP figure, keyed off its basis (see
// src/fantasyExpectedPoints.js's expectedPointsFor/blendWithCurrentSeason) -
// the one place that decides what a manager is told about where a number
// came from. "estimate" must never read like a personal record: it names the
// projection explicitly and the peer group it was drawn from
// (baselineFromCohort is a same-position median, never this player's own
// history). "history"/"blended" name the actual season(s) behind the figure,
// via `seasons` (data/PL/players.json's xpStats.seasons header), so a bare
// number never floats free of its source.
export function xpTooltip(basis, { seasons, position } = {}) {
  if (basis === "estimate") {
    return `Estimated from similar ${position ?? "players"} - a projection, not this player's own record.`;
  }
  const seasonsLabel = xpSeasonsLabel(seasons);
  if (basis === "blended") {
    return seasonsLabel
      ? `This season's form blended with actual history (${seasonsLabel}).`
      : "This season's form blended with prior history.";
  }
  if (basis === "history") {
    return seasonsLabel ? `From actual history: ${seasonsLabel}.` : "From actual season history.";
  }
  return "";
}

// "2025/26, 2024/25, 2023/24" style label for a list of season-start years
// (data/PL/players.json's xpStats.seasons), reusing priorSeasonRangeLabel's
// own single-season formatting rather than re-deriving it. Empty string for
// a missing/empty list.
export function xpSeasonsLabel(seasons) {
  return (seasons ?? []).map((season) => priorSeasonRangeLabel(season)).filter(Boolean).join(", ");
}

// -- Prior-season enrichment (appearances/minutes/tier) -----------------------
//
// scripts/fetch-fantasy-players.mjs adds appearances/minutes/tier/likelyStarter
// to every player when the prior-season stats fetch succeeds, and adds none of
// them at all when it fails outright (see enrichWithPriorSeasonStats) - never
// partial nulls standing in for a failed bake. hasPriorSeasonData checks the
// pool itself for that signal, so the pool table/drawer/scouting list degrade
// correctly (hide the columns rather than show them full of placeholders)
// even if a caller forgets to also check the file's priorSeasonStats header.
export function hasPriorSeasonData(players) {
  return (players ?? []).some((player) => player?.tier !== undefined);
}

// Display label for a player's prior-season tier chip, or null when there is
// nothing to show (no enrichment attempted, or a stray unrecognised value).
// "unknown" reads as "New" rather than "Unknown": a missing prior-season
// record means a new signing or a promoted club's player, not a judgement
// about them, and "New" says that plainly (see src/fantasyPlayerTier.js's
// deriveTier for why "unknown" outranks "fringe" in the pool's own sort).
const TIER_LABELS = { starter: "Starter", squad: "Squad", fringe: "Fringe", unknown: "New" };
export function tierLabel(tier) {
  return TIER_LABELS[tier] ?? null;
}

// "2025/26" style range label for the prior season a pool's appearances/
// minutes figures are drawn from (data/PL/players.json's
// priorSeasonStats.season, the year that season started), so a bare "37
// appearances" always has a season attached somewhere in the UI. Empty
// string for a missing/invalid season rather than a malformed label.
export function priorSeasonRangeLabel(season) {
  if (season == null || season === "") return "";
  const year = Number(season);
  if (!Number.isInteger(year)) return "";
  return `${year}/${String((year + 1) % 100).padStart(2, "0")}`;
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
            // Whether the Durable Object's alarm autopick drafted this from
            // the on-clock manager's own queue (see worker/draftRoom.js and
            // renderPickFeed's badge) rather than the generic autopick
            // fallback or a manual human pick. Always false for the latter
            // two since the server never sets it there.
            viaQueue: Boolean(message.viaQueue),
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

// -- Matchup tab pure helpers (Phase 4.3) ---------------------------------------
//
// The Matchup tab's score-comparison bar needs two small, independently
// testable derivations: which side (if either) is ahead, and how wide each
// half of the bar should be. Both are pure number-in, value-out functions so
// the view never has to special-case a scoreless (not-started) matchup
// itself - see renderFantasyMatchupPanel in fantasyView.js, which only calls
// these once it already knows the matchup has actually started.

// Which side leads the head-to-head score right now: "me" | "opponent" |
// "tied". A tie (including 0-0) is a legitimate result, not treated as
// ambiguous; the view decides separately whether a still-scheduled fixture
// should be showing scores at all.
export function matchupLeadSide(meScore, opponentScore) {
  const me = meScore ?? 0;
  const opponent = opponentScore ?? 0;
  if (me > opponent) return "me";
  if (opponent > me) return "opponent";
  return "tied";
}

// Bar widths (0-100, always summing to 100) for the score-lead comparison
// bar. A scoreless matchup (both sides at 0) splits the bar evenly rather
// than dividing by zero.
export function matchupBarWidths(meScore, opponentScore) {
  const me = Math.max(0, meScore ?? 0);
  const opponent = Math.max(0, opponentScore ?? 0);
  const total = me + opponent;
  if (total <= 0) return { me: 50, opponent: 50 };
  const mePercent = Math.round((me / total) * 100);
  return { me: mePercent, opponent: 100 - mePercent };
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
