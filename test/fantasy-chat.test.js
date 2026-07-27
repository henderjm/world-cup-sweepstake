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
