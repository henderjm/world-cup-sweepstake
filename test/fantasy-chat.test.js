import test from "node:test";
import assert from "node:assert/strict";

import {
  CHAT_EVENTS,
  CHAT_REACTIONS,
  MAX_CHAT_MESSAGE_LENGTH,
  cleanChatText,
  describeChatEvent,
  isRecapEntry,
  rollUpChatReactions,
} from "../src/fantasyChat.js";

test("cleanChatText flattens control characters so a message can never fake a new line", () => {
  const withNewlines = ["first", "second", "third"].join("\n");
  assert.equal(cleanChatText(withNewlines), "first second third");
  assert.equal(cleanChatText(`tab\there`), "tab here");
});

test("cleanChatText drops angle brackets before the renderer ever sees them", () => {
  assert.equal(cleanChatText(`<img src=x onerror=alert(1)>`), "img src=x onerror=alert(1)");
});

test("cleanChatText caps length and returns empty for whitespace-only input", () => {
  assert.equal(cleanChatText("x".repeat(MAX_CHAT_MESSAGE_LENGTH + 50)).length, MAX_CHAT_MESSAGE_LENGTH);
  assert.equal(cleanChatText("   \n\t  "), "");
  assert.equal(cleanChatText(null), "");
});

test("rollUpChatReactions counts per message and separates the caller's own", () => {
  const rows = [
    { messageId: 1, userId: 7, emoji: "🔥" },
    { messageId: 1, userId: 8, emoji: "🔥" },
    { messageId: 1, userId: 7, emoji: "💀" },
    { messageId: 2, userId: 8, emoji: "😂" },
  ];
  const rolled = rollUpChatReactions(rows, 7);
  assert.deepEqual(rolled.get(1).counts, { "🔥": 2, "💀": 1 });
  assert.deepEqual(rolled.get(1).mine.sort(), ["💀", "🔥"].sort());
  assert.deepEqual(rolled.get(2).counts, { "😂": 1 });
  assert.deepEqual(rolled.get(2).mine, []);
});

test("rollUpChatReactions accepts snake_case rows and ignores emoji outside the allowlist", () => {
  const rolled = rollUpChatReactions(
    [
      { message_id: 3, user_id: 5, emoji: "🔥" },
      { message_id: 3, user_id: 5, emoji: "🦄" },
    ],
    5,
  );
  assert.deepEqual(rolled.get(3).counts, { "🔥": 1 });
  assert.deepEqual(rolled.get(3).mine, ["🔥"]);
  assert.ok(!CHAT_REACTIONS.includes("🦄"));
});

test("rollUpChatReactions with no viewer returns counts and an empty mine", () => {
  const rolled = rollUpChatReactions([{ messageId: 1, userId: 7, emoji: "🔥" }], null);
  assert.deepEqual(rolled.get(1).counts, { "🔥": 1 });
  assert.deepEqual(rolled.get(1).mine, []);
});

test("describeChatEvent renders each system event from its payload facts", () => {
  assert.match(
    describeChatEvent({ event: CHAT_EVENTS.LEAGUE_CREATED, payload: { actor: "Ada" } }).text,
    /^Ada created the league/,
  );
  assert.match(
    describeChatEvent({ event: CHAT_EVENTS.MEMBER_JOINED, payload: { actor: "Bo" } }).text,
    /^Bo joined the league/,
  );
  assert.match(
    describeChatEvent({ event: CHAT_EVENTS.DRAFT_STARTED, payload: { managers: 8 } }).text,
    /8 managers/,
  );
  assert.match(
    describeChatEvent({ event: CHAT_EVENTS.LINEUP_SET, payload: { actor: "Cy", gameweek: 4, captain: "Haaland" } })
      .text,
    /gameweek 4 XI, captaining Haaland/,
  );
  assert.match(
    describeChatEvent({ event: CHAT_EVENTS.FREE_AGENT_ADD, payload: { actor: "Di", added: "Mbeumo", dropped: "Solanke" } })
      .text,
    /signed Mbeumo and dropped Solanke/,
  );
});

test("describeChatEvent says when a pick came from the manager's own queue", () => {
  const manual = describeChatEvent({
    event: CHAT_EVENTS.DRAFT_PICK,
    payload: { actor: "Ada", player: "Saka", team: "Arsenal", overallPick: 3, viaQueue: false },
  });
  const queued = describeChatEvent({
    event: CHAT_EVENTS.DRAFT_PICK,
    payload: { actor: "Ada", player: "Saka", team: "Arsenal", overallPick: 3, viaQueue: true },
  });
  assert.equal(manual.text, "Pick 3: Ada took Saka (Arsenal).");
  assert.equal(queued.text, "Pick 3: Ada took Saka (Arsenal) from their queue.");
});

test("describeChatEvent lists waiver run winners and handles an empty run", () => {
  const empty = describeChatEvent({ event: CHAT_EVENTS.WAIVER_RUN, payload: { gameweek: 6, moves: [] } });
  assert.match(empty.text, /No claims went through/);

  const withMoves = describeChatEvent({
    event: CHAT_EVENTS.WAIVER_RUN,
    payload: { gameweek: 6, moves: [{ actor: "Ada", added: "Wissa", dropped: "Isak", bid: 14 }] },
  });
  assert.match(withMoves.text, /Ada won Wissa for 14, dropping Isak/);
});

test("describeChatEvent never prints undefined for a missing payload field", () => {
  for (const event of Object.values(CHAT_EVENTS)) {
    const described = describeChatEvent({ event, payload: {} });
    assert.ok(described.text.length > 0);
    assert.ok(!described.text.includes("undefined"), `${event} printed undefined`);
  }
});

test("describeChatEvent falls back honestly for an event this build does not know", () => {
  const described = describeChatEvent({ event: "commissioner_did_something_new", payload: {} });
  assert.equal(described.text, "Something happened in this league.");
});

test("isRecapEntry only accepts a system recap row that actually carries a recap", () => {
  assert.equal(isRecapEntry({ kind: "system", event: CHAT_EVENTS.RECAP, payload: { recap: { headline: "hi" } } }), true);
  assert.equal(isRecapEntry({ kind: "system", event: CHAT_EVENTS.RECAP, payload: {} }), false);
  assert.equal(isRecapEntry({ kind: "message", text: "recap" }), false);
});

// -- Bot seats in the permanent history -------------------------------------------

test("filling seats with bots is announced in the feed, naming each one", () => {
  // Never slipped in quietly: somebody scrolling back has to be able to see
  // when the empty seats stopped being empty and who filled them.
  const described = describeChatEvent({
    kind: "system",
    event: CHAT_EVENTS.BOTS_ADDED,
    payload: { actor: "Alice", count: 2, bots: ["Bot Alfie", "Bot Bex"] },
  });
  assert.match(described.text, /Alice filled 2 empty seats with bot managers/);
  assert.match(described.text, /Bot Alfie, Bot Bex/);
  assert.match(described.text, /autopick/);
});

test("a bot announcement written by an older build still reads as English", () => {
  // The feed is permanent, so a row missing the field its sentence wants must
  // degrade rather than print "undefined".
  const described = describeChatEvent({ kind: "system", event: CHAT_EVENTS.BOTS_ADDED, payload: { actor: "Alice" } });
  assert.doesNotMatch(described.text, /undefined/);
  assert.match(described.text, /Alice filled 0 empty seats/);

  const removed = describeChatEvent({ kind: "system", event: CHAT_EVENTS.BOT_REMOVED, payload: {} });
  assert.equal(removed.text, "Someone removed a bot manager from the league.");
});


test("the feed says who was named defending champion, and copes with a payload missing a name", () => {
  const named = describeChatEvent({
    kind: "system",
    event: CHAT_EVENTS.CHAMPION_SET,
    payload: { actor: "Alice", manager: "Rory" },
  });
  assert.equal(named.text, "Alice named Rory the defending champion.");
  assert.equal(named.icon, "\u{1F3C6}");

  // A row written before the payload carried a name must still read as English.
  const bare = describeChatEvent({ kind: "system", event: CHAT_EVENTS.CHAMPION_SET, payload: {} });
  assert.equal(bare.text, "Someone named a manager the defending champion.");
  assert.doesNotMatch(bare.text, /undefined|null/);

  const cleared = describeChatEvent({
    kind: "system",
    event: CHAT_EVENTS.CHAMPION_CLEARED,
    payload: { actor: "Alice" },
  });
  assert.equal(cleared.text, "Alice cleared the defending champion.");
});
