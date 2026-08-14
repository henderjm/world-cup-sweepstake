// League chat: the pure half. Shared by the Worker (validation, caps, the
// system-event payload contract) and the browser (formatting a stored event
// back into a sentence), exactly like analysisPrompt.js and fantasyWaivers.js
// are shared. No DOM, no fetch, no D1.
//
// The feed is deliberately ONE append-only table carrying two kinds of row:
//
//   kind "message" - a human wrote it. `text` is the whole content.
//   kind "system"  - the app wrote it. `event` names what happened and
//                    `payload` carries the structured facts.
//
// System events store FACTS, never pre-rendered prose. A stored sentence
// freezes today's wording into the permanent history of every league, so
// changing "picked" to "drafted" would leave a feed speaking two dialects.
// describeChatEvent below is what turns facts into words, at read time, so the
// wording is always the current build's.
//
// Payload values are denormalised on write (a manager's display name is copied
// into the payload rather than joined at read time) because the feed is a
// history: it should say who did a thing under the name they had when they did
// it, and it must keep reading correctly after that account is gone.

// Fixed allowlist, same reasoning as banter's REACTIONS: without it the
// reaction table becomes a place to stash arbitrary strings.
export const CHAT_REACTIONS = ["🔥", "😂", "😱", "🧂", "🐐", "💀"];

// One message's ceiling. Matches banter's cleanText slice so the two feeds
// cannot disagree about what "too long" means.
export const MAX_CHAT_MESSAGE_LENGTH = 280;

// Per-league ceiling on human messages. System events are NOT counted against
// it: a league that chatted its way to the cap must still get told that its
// waiver run happened, and the app's own output is bounded by the season
// anyway (38 gameweeks, a fixed number of events each).
export const MAX_CHAT_MESSAGES_PER_LEAGUE = 2000;

// How many entries a single feed read returns. The client renders oldest-last,
// so the Worker selects newest-first and reverses.
export const CHAT_PAGE_SIZE = 80;

// Every system event this app can emit. Anything not in here is rendered as a
// neutral fallback rather than trusted: the renderer must never be the thing
// that decides an unknown event is safe to describe.
export const CHAT_EVENTS = Object.freeze({
  LEAGUE_CREATED: "league_created",
  MEMBER_JOINED: "member_joined",
  TEAM_RENAMED: "team_renamed",
  BOTS_ADDED: "bots_added",
  BOT_REMOVED: "bot_removed",
  DRAFT_STARTED: "draft_started",
  DRAFT_PICK: "draft_pick",
  DRAFT_COMPLETED: "draft_completed",
  LINEUP_SET: "lineup_set",
  FREE_AGENT_ADD: "free_agent_add",
  WAIVER_RUN: "waiver_run",
  RECAP: "recap",
  DRAFT_RECAP: "draft_recap",
  AUTOPILOT_ON: "autopilot_on",
  AUTOPILOT_OFF: "autopilot_off",
  AUTOPILOT_MOVE: "autopilot_move",
});

// Cleans a human message. Control characters become spaces (a newline in a
// one-line feed row is only ever a layout attack), angle brackets are dropped
// outright so nothing user-typed can look like markup even before the
// renderer escapes it, and the whole thing is capped. Returns "" for anything
// that is only whitespace, which the caller treats as "no message".
export function cleanChatText(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CHAT_MESSAGE_LENGTH);
}

// Rolls the flat (message_id, user_id, emoji) rows a read returns into
// per-message counts plus the caller's own set, the same shape banter's
// readBanter produces for a match. `userId` null (a signed-out reader) yields
// an empty `mine` rather than being an error.
export function rollUpChatReactions(rows, userId) {
  const byMessage = new Map();
  for (const row of rows ?? []) {
    const messageId = row?.messageId ?? row?.message_id;
    if (messageId == null) continue;
    if (!CHAT_REACTIONS.includes(row.emoji)) continue; // a row from an older allowlist
    let entry = byMessage.get(messageId);
    if (!entry) {
      entry = { counts: {}, mine: [] };
      byMessage.set(messageId, entry);
    }
    entry.counts[row.emoji] = (entry.counts[row.emoji] ?? 0) + 1;
    const rowUserId = row.userId ?? row.user_id;
    if (userId != null && rowUserId === userId) entry.mine.push(row.emoji);
  }
  return byMessage;
}

// Turns one stored system event into a sentence, as plain text: `{ icon, text }`.
// The caller escapes it (nothing here produces markup, and it must stay that
// way, since payload values are user-supplied).
//
// An unknown event, or a payload missing the field its sentence needs, falls
// back to something honest rather than printing "undefined": the feed is
// permanent, so a row written by a future build and read by an older one must
// still be legible.
export function describeChatEvent(entry) {
  const payload = entry?.payload ?? {};
  const actor = payload.actor || "Someone";
  // "gameweek 7" when the payload says so, a bare "gameweek" when it does not.
  // A row written by a build that named the field differently must still read
  // as English rather than as "gameweek undefined".
  const week = payload.gameweek == null ? "gameweek" : `gameweek ${payload.gameweek}`;

  switch (entry?.event) {
    case CHAT_EVENTS.LEAGUE_CREATED:
      return { icon: "🏆", text: `${actor} created the league.` };

    case CHAT_EVENTS.MEMBER_JOINED:
      return { icon: "👋", text: `${actor} joined the league.` };

    // A rename is announced rather than applied silently: the standings simply
    // showing an unfamiliar name is how a league ends up asking "who is that".
    // `actor` is the ACCOUNT name captured at write time, so the sentence still
    // identifies the person even though every other surface now shows the team.
    case CHAT_EVENTS.TEAM_RENAMED:
      return payload?.teamName
        ? { icon: "✏️", text: `${actor} renamed their team to ${payload.teamName}.` }
        : { icon: "✏️", text: `${actor} cleared their team name.` };

    // Named in the feed rather than slipped in quietly: a manager scrolling
    // back must be able to see exactly when the empty seats stopped being
    // empty and who filled them, because a bot showing up unannounced in the
    // draft order is the version of this feature that misleads people.
    case CHAT_EVENTS.BOTS_ADDED: {
      const names = Array.isArray(payload.bots) ? payload.bots.filter(Boolean) : [];
      const count = payload.count ?? names.length;
      const who = names.length ? ` (${names.join(", ")})` : "";
      return {
        icon: "🤖",
        text: `${actor} filled ${count} empty seat${count === 1 ? "" : "s"} with bot managers${who}. Bots autopick and always field a legal XI.`,
      };
    }

    case CHAT_EVENTS.BOT_REMOVED:
      return { icon: "🤖", text: `${actor} removed ${payload.bot || "a bot manager"} from the league.` };

    case CHAT_EVENTS.DRAFT_STARTED:
      return {
        icon: "⏱️",
        text: payload.managers
          ? `The draft is under way with ${payload.managers} managers.`
          : "The draft is under way.",
      };

    case CHAT_EVENTS.DRAFT_PICK: {
      const pick = payload.overallPick ? `Pick ${payload.overallPick}` : "Pick";
      const player = payload.player || "a player";
      const club = payload.team ? ` (${payload.team})` : "";
      // How the pick was made is worth saying out loud: an autopick off a
      // manager's own shortlist reads very differently from a manager actually
      // being at the keyboard, and a clock expiring with an empty queue reads
      // differently again.
      //
      // `viaQueue` is the older boolean this replaced (see PICK_VIA in
      // src/draftLogic.js). Rows written before `via` existed carry only that,
      // and the feed is permanent history, so it stays as the fallback rather
      // than leaving old picks reading as if nobody knows how they happened.
      // A bot's seat says nothing here: its name already labels it, and
      // "autopicked" on every one of its fifteen picks is noise.
      const how = describePickVia(payload.via, payload.viaQueue);
      return { icon: "📋", text: `${pick}: ${actor} took ${player}${club}${how}.` };
    }

    case CHAT_EVENTS.DRAFT_COMPLETED:
      return { icon: "✅", text: "The draft is complete. Squads are locked in." };

    case CHAT_EVENTS.LINEUP_SET:
      return {
        icon: "🧤",
        text: payload.captain
          ? `${actor} set their ${week} XI, captaining ${payload.captain}.`
          : `${actor} set their ${week} XI.`,
      };

    case CHAT_EVENTS.FREE_AGENT_ADD:
      return {
        icon: "⚡",
        text: `${actor} signed ${payload.added || "a free agent"} and dropped ${payload.dropped || "a player"}.`,
      };

    case CHAT_EVENTS.WAIVER_RUN: {
      const moves = Array.isArray(payload.moves) ? payload.moves : [];
      if (!moves.length) {
        return { icon: "📨", text: `Waivers ran for ${week}. No claims went through.` };
      }
      const lines = moves.map((move) => {
        const bid = move.bid == null ? "" : ` for ${move.bid}`;
        return `${move.actor || "Someone"} won ${move.added || "a player"}${bid}, dropping ${move.dropped || "a player"}`;
      });
      return { icon: "📨", text: `Waivers ran for ${week}. ${lines.join("; ")}.` };
    }

    // Autopilot is announced in the feed for the same reason bots being added
    // is: a team that starts playing itself must never do so quietly. The
    // manager whose seat it is reads this too, and it is how they find out.
    case CHAT_EVENTS.AUTOPILOT_ON:
      return {
        icon: "🤖",
        text: `${actor} put ${payload.manager || "a manager"}'s team on autopilot. The bots will set its lineup until ${payload.manager || "they"} next make a move.`,
      };

    case CHAT_EVENTS.AUTOPILOT_OFF:
      // Two ways off, and they read differently on purpose: a manager coming
      // back is the good outcome and should look like one.
      return payload.returned
        ? { icon: "🙌", text: `${payload.manager || "A manager"} is back. Autopilot is off.` }
        : { icon: "🤖", text: `${actor} took ${payload.manager || "a manager"}'s team off autopilot.` };

    case CHAT_EVENTS.AUTOPILOT_MOVE:
      return {
        icon: "🤖",
        text: `Autopilot signed ${payload.added || "a player"} and dropped ${payload.dropped || "a player"} for ${payload.manager || "an absent manager"}.`,
      };

    case CHAT_EVENTS.DRAFT_RECAP:
      // Like RECAP below, this has its own rich renderer (the payload carries
      // every team's grade, highlights and projection), so this is only the
      // one-line summary a compact view falls back to.
      return {
        icon: "🎓",
        text: payload.recap?.headline || "The draft grades are in.",
      };

    case CHAT_EVENTS.RECAP:
      // The recap has its own rich renderer (the payload carries rankings,
      // awards and the model's prose), so this is only the one-line summary a
      // compact view falls back to.
      return {
        icon: "🤖",
        text: payload.recap?.headline || `The ${week} recap is in.`,
      };

    default:
      return { icon: "•", text: "Something happened in this league." };
  }
}

// The trailing clause on a draft-pick line. Kept beside describeChatEvent
// rather than imported from draftLogic.js so the feed's vocabulary stays in
// one file; the string values themselves are PICK_VIA's and are matched, never
// re-derived.
function describePickVia(via, legacyViaQueue) {
  switch (via) {
    case "queue":
      return " from their queue";
    case "autopick":
      return ", autopicked on the clock";
    case "manual":
    case "bot":
      return "";
    default:
      // No `via` at all: a row from before the column existed. Only the old
      // boolean is knowable, and only in one direction - false meant "not from
      // a queue", which covered manual and autopick alike, so it cannot be
      // reported as either.
      return legacyViaQueue ? " from their queue" : "";
  }
}

// True when an entry should render through the full recap card rather than as
// a one-line system row. Kept here (not in the view) so the Worker's own
// notion of "this is a recap" and the renderer's cannot drift.
export function isRecapEntry(entry) {
  return entry?.kind === "system" && entry?.event === CHAT_EVENTS.RECAP && Boolean(entry?.payload?.recap);
}

// The same test for the post-draft recap, which renders through its own card
// rather than the weekly one: the payloads carry different shapes (grades and
// projections, not rankings and awards) and a renderer must never guess.
export function isDraftRecapEntry(entry) {
  return entry?.kind === "system" && entry?.event === CHAT_EVENTS.DRAFT_RECAP && Boolean(entry?.payload?.recap);
}
