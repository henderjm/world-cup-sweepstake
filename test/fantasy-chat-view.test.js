import assert from "node:assert/strict";
import test from "node:test";

import { renderFantasyFeedPanel, renderFeedEntries, renderRecapCard } from "../src/fantasyChatView.js";
import { CHAT_EVENTS } from "../src/fantasyChat.js";

const MESSAGE = {
  id: 1,
  kind: "message",
  userId: 7,
  name: "Ada",
  text: "unlucky mate",
  ts: "2026-03-01T10:00:00Z",
  reactions: { counts: { "😂": 2 }, mine: ["😂"] },
};

const SYSTEM = {
  id: 2,
  kind: "system",
  event: CHAT_EVENTS.WAIVER_RUN,
  payload: { gameweek: 6, moves: [{ actor: "Bo", added: "Wissa", dropped: "Isak", bid: 14 }] },
  ts: "2026-03-01T09:00:00Z",
  reactions: { counts: {}, mine: [] },
};

const RECAP_ENTRY = {
  id: 3,
  kind: "system",
  event: CHAT_EVENTS.RECAP,
  payload: {
    gameweek: 6,
    recap: {
      gameweek: 6,
      headline: "Ada runs away with it",
      matchups: "Ada put 80 on Bo.",
      lookahead: "Bo faces Di next.",
      results: [{ home: "Ada", away: "Bo", homeScore: 80, awayScore: 42, winnerUserId: 7 }],
      rankings: [
        { userId: 7, name: "Ada", rank: 1, movement: 2, powerScore: 71.2, record: "2-0-0", note: "Flying." },
        { userId: 8, name: "Bo", rank: 2, movement: null, powerScore: 44.1, record: "0-0-2", note: "" },
      ],
      awards: [{ key: "benchKing", title: "Bench king", name: "Bo", points: 22, detail: "Haaland led the bench on 18", note: "Ouch." }],
    },
  },
  ts: "2026-03-01T08:00:00Z",
  reactions: { counts: {}, mine: [] },
};

test("the feed renders events and human messages in one timeline", () => {
  const html = renderFeedEntries([SYSTEM, MESSAGE], { myUserId: 7 });
  const systemAt = html.indexOf("Waivers ran for gameweek 6");
  const messageAt = html.indexOf("unlucky mate");
  assert.ok(systemAt > -1, "the waiver run should be described in the feed");
  assert.ok(messageAt > -1, "the human message should be in the same feed");
  // Same list, in the order given: a transaction and the reply to it are
  // neighbours, which is the entire point of the single stream.
  assert.ok(systemAt < messageAt);
  assert.equal(html.split("<li").length - 1, 2);
});

test("the feed marks the viewer's own messages", () => {
  const mine = renderFeedEntries([MESSAGE], { myUserId: 7 });
  const theirs = renderFeedEntries([MESSAGE], { myUserId: 99 });
  assert.match(mine, /fantasy-feed-row--message[^"]*is-mine/);
  // Scoped to the row's own class: the reaction chip has an unrelated is-mine
  // of its own, driven by the server's per-viewer `mine` list.
  assert.doesNotMatch(theirs, /fantasy-feed-row--message[^"]*is-mine/);
});

test("an empty feed explains what will land in it rather than showing nothing", () => {
  const html = renderFeedEntries([], {});
  assert.match(html, /fantasy-feed-empty/);
  assert.match(html, /claim/);
});

test("a pending optimistic message renders dimmed and without reaction controls", () => {
  const html = renderFeedEntries([{ id: null, kind: "message", name: "You", text: "hi", pending: true }], {});
  assert.match(html, /is-pending/);
  assert.doesNotMatch(html, /data-feed-react/);
});

test("reactions render existing counts plus an add control, and disable when signed out", () => {
  const signedIn = renderFeedEntries([MESSAGE], { myUserId: 7, signedIn: true });
  assert.match(signedIn, /data-feed-react="😂"/);
  assert.match(signedIn, /data-feed-message="1"/);
  assert.match(signedIn, /is-mine/);

  const signedOut = renderFeedEntries([MESSAGE], { myUserId: null, signedIn: false });
  assert.match(signedOut, /bn-react fantasy-feed-react[^>]*disabled/);
});

// -- Escaping ------------------------------------------------------------------
// Every one of these strings is user-controlled: a manager's display name, the
// text they typed, and (via the league and manager names the recap quotes) the
// prose the model wrote about them.

const XSS = `<img src=x onerror="alert('pwn')">`;

test("a hostile message body is escaped, not rendered", () => {
  const html = renderFeedEntries([{ ...MESSAGE, text: XSS }], { myUserId: 7 });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&#39;pwn&#39;/);
});

test("a hostile display name is escaped", () => {
  const html = renderFeedEntries([{ ...MESSAGE, name: XSS }], { myUserId: 7 });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test("a hostile system-event payload value is escaped", () => {
  const html = renderFeedEntries(
    [{ ...SYSTEM, payload: { gameweek: 6, moves: [{ actor: XSS, added: "Wissa", dropped: "Isak" }] } }],
    {},
  );
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test("hostile recap prose is escaped", () => {
  const html = renderRecapCard({
    ...RECAP_ENTRY.payload.recap,
    headline: XSS,
    rankings: [{ userId: 7, name: XSS, rank: 1, movement: 1, powerScore: 10, record: "1-0-0", note: XSS }],
  });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

// -- The recap card ------------------------------------------------------------

test("the recap card shows the computed numbers even with no model prose at all", () => {
  const html = renderRecapCard({
    gameweek: 6,
    headline: "Gameweek 6 recap",
    matchups: "",
    lookahead: "",
    results: RECAP_ENTRY.payload.recap.results,
    rankings: RECAP_ENTRY.payload.recap.rankings.map((row) => ({ ...row, note: "" })),
    awards: [{ key: "benchKing", title: "Bench king", name: "Bo", points: 22, detail: "Haaland led the bench on 18", note: "" }],
  });
  // Bland but correct is the requirement: the figures survive even when the
  // model contributed nothing.
  assert.match(html, /80 - 42/);
  assert.match(html, /power 71\.2/);
  assert.match(html, /Bench king/);
  assert.match(html, /Haaland led the bench on 18/);
});

test("the recap card distinguishes a climb, a fall and a new entry", () => {
  const html = renderRecapCard({
    gameweek: 6,
    headline: "x",
    rankings: [
      { userId: 1, name: "Up", rank: 1, movement: 2, powerScore: 1, record: "1-0-0", note: "" },
      { userId: 2, name: "Down", rank: 2, movement: -1, powerScore: 1, record: "1-0-0", note: "" },
      { userId: 3, name: "Same", rank: 3, movement: 0, powerScore: 1, record: "1-0-0", note: "" },
      { userId: 4, name: "New", rank: 4, movement: null, powerScore: 1, record: "1-0-0", note: "" },
    ],
    awards: [],
    results: [],
  });
  assert.match(html, /is-up">▲2/);
  assert.match(html, /is-down">▼1/);
  assert.match(html, /fantasy-recap-move">·/);
  assert.match(html, /fantasy-recap-move--new">new/);
});

test("the recap card credits the split: our numbers, the model's words", () => {
  const html = renderRecapCard(RECAP_ENTRY.payload.recap);
  assert.match(html, /Numbers computed from your league's results/);
});

test("a recap entry renders as its own card inside the feed", () => {
  const html = renderFeedEntries([RECAP_ENTRY], { myUserId: 7 });
  assert.match(html, /fantasy-feed-row--recap/);
  assert.match(html, /Ada runs away with it/);
  assert.match(html, /Power rankings/);
});

// -- The panel -----------------------------------------------------------------

test("the panel shows a loading note before the first fetch lands", () => {
  assert.match(renderFantasyFeedPanel(null, {}), /Loading the league feed/);
});

test("the panel offers a retry on a load failure", () => {
  const html = renderFantasyFeedPanel(null, { error: "nope" });
  assert.match(html, /data-feed-retry/);
  assert.match(html, /nope/);
});

test("the panel shows a compose box only when signed in", () => {
  const feed = { entries: [MESSAGE], viewerUserId: 7 };
  assert.match(renderFantasyFeedPanel(feed, { myUserId: 7, signedIn: true }), /data-feed-form/);
  assert.doesNotMatch(renderFantasyFeedPanel(feed, { myUserId: null, signedIn: false }), /data-feed-form/);
});

test("the panel wraps the timeline in the surgical-refresh hook the poll uses", () => {
  const html = renderFantasyFeedPanel({ entries: [MESSAGE], viewerUserId: 7 }, { myUserId: 7 });
  assert.match(html, /data-feed-list/);
});

// The feed opens at the top and mostly carries app events, so the newest thing
// has to be the first thing. It previously rendered oldest-first (chat
// convention), which meant landing on a league showed the oldest event in it.
test("feed entries render in the order given, newest first", () => {
  const entries = [
    { id: 3, kind: "message", name: "C", text: "newest", ts: "2026-08-15T12:00:00Z", reactions: { counts: {}, mine: [] } },
    { id: 2, kind: "message", name: "B", text: "middle", ts: "2026-08-15T11:00:00Z", reactions: { counts: {}, mine: [] } },
    { id: 1, kind: "message", name: "A", text: "oldest", ts: "2026-08-15T10:00:00Z", reactions: { counts: {}, mine: [] } },
  ];
  const html = renderFeedEntries(entries, {});
  assert.ok(
    html.indexOf("newest") < html.indexOf("middle") && html.indexOf("middle") < html.indexOf("oldest"),
    "entries should render in the order supplied, newest at the top",
  );
});
