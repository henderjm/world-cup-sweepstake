import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { FantasyDraftRoom } from "../worker/draftRoom.js";
import { SQUAD_SIZE, SQUAD_SLOTS } from "../src/fantasy.js";
import { BOT_PICK_CLOCK_MS, HUMAN_PICK_CLOCK_MS } from "../src/fantasyBots.js";
import { PICK_VIA } from "../src/draftLogic.js";

// A draft that COMPLETES with a mix of human and bot managers, driven through
// the real FantasyDraftRoom class against the real baked player pool.
//
// This file exists because bot managers are pointless if the pick clock does
// not advance on its own. The whole premise is a member whose clock always
// expires, which means the alarm has to keep firing with NOBODY connected: no
// WebSocket, no browser, no human. That is the case that matters (a
// bot-filled league is by definition mostly unattended) and it is the one most
// likely to be quietly broken, because every other path through this class is
// driven by a socket message.
//
// draftRoom.js's own header says it cannot be exercised by node:test, and that
// is true of the socket paths: acceptWebSocket and serializeAttachment are
// Workers-runtime APIs. The ALARM path needs none of them. It needs durable
// storage (a Map), blockConcurrencyWhile (await the callback) and D1 (a stub
// that stores rows and enforces the one unique index the commit path depends
// on). All three are small enough to be obviously faithful, and what is being
// tested is the real class, not a re-implementation of it.

const POOL = JSON.parse(readFileSync(new URL("../data/PL/players.json", import.meta.url), "utf8"));

// Durable Object storage plus the alarm. setAlarm records the deadline rather
// than scheduling anything: the test drives the clock itself, which is the only
// way to run 150 picks in a millisecond instead of in real time.
function fakeState() {
  const storage = new Map();
  let alarm = null;
  return {
    storage: {
      get: async (key) => storage.get(key),
      put: async (key, value) => void storage.set(key, value),
      getAlarm: async () => alarm,
      setAlarm: async (at) => void (alarm = at),
      deleteAlarm: async () => void (alarm = null),
    },
    // Every real call is already serialised by the test's own await, so this
    // only has to run the callback. It must still be present: the class calls
    // it around both the pick and the autopick paths.
    blockConcurrencyWhile: async (fn) => fn(),
    getWebSockets: () => [],
    acceptWebSocket: () => {},
    // Test-only accessors.
    peekAlarm: () => alarm,
  };
}

// A D1 stub that really stores the three tables the commit path writes, and
// really enforces fantasy_draft_picks(league_id, overall_pick). The unique
// index is not decoration here: commitPick's whole lost-race branch keys off
// it, so a stub that silently accepted a duplicate slot would let this suite
// pass while the real thing corrupted a draft.
function fakeDb({ members, queues = [] }) {
  const picks = [];
  const rosters = [];
  const chat = [];
  const fixtures = [];
  const leagues = new Map([[1, { draft_status: "drafting" }]]);
  const seenSlots = new Set();

  const make = (sql) => {
    const normalised = sql.replace(/\s+/g, " ").trim();
    const statement = {
      sql: normalised,
      bound: [],
      bind: (...args) => {
        statement.bound = args;
        return statement;
      },
      first: async () => {
        if (normalised.startsWith("SELECT draft_status FROM fantasy_leagues")) {
          return leagues.get(statement.bound[0]) ?? null;
        }
        return null;
      },
      all: async () => {
        if (normalised.includes("FROM fantasy_league_members m")) return { results: members };
        if (normalised.includes("FROM fantasy_draft_picks")) return { results: picks };
        // A manager's own shortlist, which is what separates a `queue`
        // autopick from a generic one. Empty by default, so every existing
        // test in this file keeps exercising the generic path.
        if (normalised.includes("FROM fantasy_draft_queue")) return { results: queues };
        return { results: [] };
      },
      run: async () => ({ success: true, meta: { changes: 1, last_row_id: 1 } }),
    };
    return statement;
  };

  const apply = (statement) => {
    const b = statement.bound;
    if (statement.sql.startsWith("INSERT INTO fantasy_draft_picks")) {
      const key = `${b[0]}:${b[3]}`;
      if (seenSlots.has(key)) throw new Error("D1_ERROR: UNIQUE constraint failed: fantasy_draft_picks.overall_pick");
      seenSlots.add(key);
      // `via` is stored on the row exactly as D1 holds it, so a rehydrate
      // (which re-reads this same array) sees what a real restart would.
      picks.push({
        round: b[1],
        pick_in_round: b[2],
        overall_pick: b[3],
        user_id: b[4],
        player_id: b[5],
        via: b[6],
      });
    } else if (statement.sql.startsWith("INSERT INTO fantasy_rosters")) {
      rosters.push({ league_id: b[0], user_id: b[1], player_id: b[2] });
    } else if (statement.sql.startsWith("INSERT INTO fantasy_chat_messages")) {
      chat.push({ event: b[1], payload: JSON.parse(b[2] ?? "{}") });
    } else if (statement.sql.startsWith("INSERT INTO fantasy_h2h_fixtures")) {
      fixtures.push({ gameweek: b[1], home: b[2], away: b[3] });
    } else if (statement.sql.startsWith("UPDATE fantasy_leagues SET draft_status")) {
      leagues.set(b[0], { draft_status: "complete" });
    }
  };

  return {
    tables: { picks, rosters, chat, fixtures, leagues },
    prepare: (sql) => make(sql),
    // A D1 batch is a transaction: a throw from any statement must leave none
    // of them applied, which is exactly what the unique index has to do to the
    // pick's feed announcement riding in the same batch.
    batch: async (statements) => {
      const snapshot = { picks: picks.length, rosters: rosters.length, chat: chat.length };
      try {
        for (const statement of statements) apply(statement);
      } catch (error) {
        picks.length = snapshot.picks;
        rosters.length = snapshot.rosters;
        chat.length = snapshot.chat;
        throw error;
      }
      return [];
    },
  };
}

function makeRoom({ humans, bots, queues = [] }) {
  const members = [
    ...Array.from({ length: humans }, (_, i) => ({
      user_id: i + 1,
      name: `Human ${i + 1}`,
      email: `h${i + 1}@example.test`,
      is_bot: 0,
    })),
    ...Array.from({ length: bots }, (_, i) => ({
      user_id: 100 + i,
      name: `Bot ${i + 1}`,
      email: `bot-${i}@bots.invalid`,
      is_bot: 1,
    })),
  ];
  const state = fakeState();
  const db = fakeDb({ members, queues });
  const room = new FantasyDraftRoom(state, { DB: db, SITE_ORIGIN: "https://example.test" });
  // Seeded so loadPlayerPool never reaches for the network. This is the exact
  // shape it caches after its own fetch, so nothing downstream can tell.
  state.storage.put("playerPool", { lastUpdated: POOL.lastUpdated, players: POOL.players });
  return { room, state, db, members };
}

// Runs the clock forward until the draft completes, or gives up. Nothing is
// connected: every pick in here comes from the alarm.
async function runDraftToCompletion(room, state, { maxTicks = 1000 } = {}) {
  const clocks = [];
  let ticks = 0;
  while (state.peekAlarm() != null && ticks < maxTicks) {
    clocks.push(state.peekAlarm());
    ticks += 1;
    await room.alarm();
  }
  return { ticks, clocks };
}

test("a draft with no connected client completes end to end on the alarm alone", async () => {
  // The premise of the whole feature: a bot is a member whose clock always
  // expires, so if the alarm did not advance unattended, bot-filling would do
  // nothing at all.
  const { room, state, db } = makeRoom({ humans: 2, bots: 6 });

  await room.fetch(
    new Request("https://draft-room/start", { method: "POST", headers: { "X-Draft-League-Id": "1" } }),
  );
  assert.notEqual(state.peekAlarm(), null, "starting the draft did not arm the pick clock");

  const { ticks } = await runDraftToCompletion(room, state);

  const expectedPicks = 8 * SQUAD_SIZE; // 120
  assert.equal(db.tables.picks.length, expectedPicks, `draft stalled after ${ticks} ticks`);
  assert.equal(db.tables.leagues.get(1).draft_status, "complete");
  assert.equal(state.peekAlarm(), null, "the clock was left armed after the draft finished");
});

test("every manager, human and bot alike, ends with a full and legal squad", async () => {
  const { room, db, state, members } = makeRoom({ humans: 3, bots: 5 });
  await room.fetch(
    new Request("https://draft-room/start", { method: "POST", headers: { "X-Draft-League-Id": "1" } }),
  );
  await runDraftToCompletion(room, state);

  const byId = new Map(POOL.players.map((player) => [player.id, player]));
  const drafted = new Set();
  for (const member of members) {
    const squad = db.tables.rosters
      .filter((row) => row.user_id === member.user_id)
      .map((row) => byId.get(row.player_id));
    assert.equal(squad.length, SQUAD_SIZE, `${member.name} did not fill a squad`);
    const counts = {};
    for (const player of squad) {
      assert.ok(player, `${member.name} holds a player that is not in the pool`);
      counts[player.position] = (counts[player.position] ?? 0) + 1;
      // No player may be owned twice anywhere in the league.
      assert.equal(drafted.has(player.id), false, `${player.name} was drafted twice`);
      drafted.add(player.id);
    }
    assert.deepEqual(counts, SQUAD_SLOTS, `${member.name}'s squad shape is illegal`);
  }
});

test("a bot's turn runs on the short clock and a human's on the full one", async () => {
  // Without this an eight-bot league would take two hours of wall clock to
  // draft, which defeats the point of filling the seats at all.
  const { room, state, members } = makeRoom({ humans: 1, bots: 3 });
  await room.fetch(
    new Request("https://draft-room/start", { method: "POST", headers: { "X-Draft-League-Id": "1" } }),
  );

  const botIds = new Set(members.filter((m) => m.is_bot).map((m) => m.user_id));
  const windows = [];
  for (let i = 0; i < 12 && state.peekAlarm() != null; i += 1) {
    const before = Date.now();
    const onClock = room.currentOnClockUserId();
    windows.push({ isBot: botIds.has(onClock), ms: state.peekAlarm() - before });
    await room.alarm();
  }

  const botWindows = windows.filter((w) => w.isBot).map((w) => w.ms);
  const humanWindows = windows.filter((w) => !w.isBot).map((w) => w.ms);
  assert.ok(botWindows.length && humanWindows.length, "the sample covered only one kind of manager");
  // Allowing a couple of milliseconds of drift between the setAlarm and the
  // Date.now() above it; the two values differ by an order of magnitude, so
  // the assertion is nowhere near that tolerance.
  for (const ms of botWindows) assert.ok(Math.abs(ms - BOT_PICK_CLOCK_MS) < 500, `bot clock was ${ms}ms`);
  for (const ms of humanWindows) assert.ok(Math.abs(ms - HUMAN_PICK_CLOCK_MS) < 500, `human clock was ${ms}ms`);
});

test("the league feed records every autopicked bot seat by name", async () => {
  // A bot must be visible in the permanent history too, not only in the live
  // draft room: the feed's payload denormalises the manager's name on write,
  // which is why a bot's stored name labels itself.
  const { room, state, db } = makeRoom({ humans: 1, bots: 3 });
  await room.fetch(
    new Request("https://draft-room/start", { method: "POST", headers: { "X-Draft-League-Id": "1" } }),
  );
  await runDraftToCompletion(room, state);

  const pickEvents = db.tables.chat.filter((row) => row.event === "draft_pick");
  assert.equal(pickEvents.length, 4 * SQUAD_SIZE);
  const botAnnouncements = pickEvents.filter((row) => /^Bot /.test(row.payload.actor));
  assert.equal(botAnnouncements.length, 3 * SQUAD_SIZE);
  assert.ok(db.tables.chat.some((row) => row.event === "draft_completed"));
});

test("a full round-robin season is scheduled for a bot-filled league", async () => {
  // The point of drafting at all: a league that completes with bots in it has
  // a real season waiting for it, not a dead-end roster board.
  const { room, state, db } = makeRoom({ humans: 2, bots: 4 });
  await room.fetch(
    new Request("https://draft-room/start", { method: "POST", headers: { "X-Draft-League-Id": "1" } }),
  );
  await runDraftToCompletion(room, state);

  assert.equal(db.tables.fixtures.length, 38 * 3); // six managers, three fixtures a week
  const gameweeks = new Set(db.tables.fixtures.map((row) => row.gameweek));
  assert.equal(gameweeks.size, 38);
});

test("a lost pick slot rolls back its feed announcement rather than half-committing", async () => {
  // Defense in depth for the eviction-boundary race the unique index exists
  // for: the pick and its announcement ride in the SAME batch, so a rejected
  // slot must leave no phantom message behind.
  const { room, state, db } = makeRoom({ humans: 1, bots: 1 });
  await room.fetch(
    new Request("https://draft-room/start", { method: "POST", headers: { "X-Draft-League-Id": "1" } }),
  );
  await room.alarm();
  assert.equal(db.tables.picks.length, 1);
  const chatBefore = db.tables.chat.length;

  // Force the next commit onto a slot that is already taken, which is exactly
  // what a second instance writing the same overall_pick would do.
  room.draft.overallPick = 1;
  const player = POOL.players.find((p) => !db.tables.picks.some((row) => row.player_id === p.id));
  const result = await room.commitPick(room.draft.memberIds[0], player);

  assert.equal(result.ok, false);
  assert.equal(db.tables.picks.length, 1, "a duplicate slot was written");
  assert.equal(db.tables.chat.length, chatBefore, "a pick that never happened was announced");
});

// -- How each pick was made (fantasy_draft_picks.via) --------------------------
//
// The signal that separates "a draft happened" from "a draft worked". It is
// proved HERE, on the harness that runs the real Durable Object through a whole
// draft, rather than as an isolated unit test of resolvePickVia: the taxonomy
// is only worth anything if the two code paths that write it (a socket message
// and the clock alarm) actually reach the right branch under real conditions,
// and that is exactly what a pure test of the decision function cannot show.

// The socket paths need Workers-runtime APIs to ACCEPT a WebSocket, but
// webSocketMessage itself only ever calls deserializeAttachment() and send()
// on one. Both are trivially faithful, so the manual pick path can be driven
// for real rather than by calling commitPick directly and assuming.
function fakeSocket(userId, leagueId) {
  const sent = [];
  return {
    sent,
    deserializeAttachment: () => ({ userId, leagueId }),
    send: (text) => sent.push(JSON.parse(text)),
  };
}

// A shortlist long enough to survive a few rounds of other managers taking
// players off it, spread across all four buckets so it stays legal as the
// manager's own squad fills up.
function queueFor(userId, count = 40) {
  return POOL.players.slice(0, count).map((player) => ({ user_id: userId, player_id: player.id }));
}

test("every pick in a completed draft records how it was made", async () => {
  // The blanket assertion: no row escapes without the signal, whatever path
  // produced it. A single null here means some branch of commitPick's callers
  // was missed and that league's engagement number is silently partial.
  const { room, state, db } = makeRoom({ humans: 2, bots: 3 });
  await room.fetch(
    new Request("https://draft-room/start", { method: "POST", headers: { "X-Draft-League-Id": "1" } }),
  );
  await runDraftToCompletion(room, state);

  assert.equal(db.tables.picks.length, 5 * SQUAD_SIZE);
  const values = new Set(db.tables.picks.map((row) => row.via));
  for (const via of values) {
    assert.ok(Object.values(PICK_VIA).includes(via), `a pick was written with an unknown via: ${String(via)}`);
  }
  assert.equal(
    db.tables.picks.filter((row) => row.via == null).length,
    0,
    "a pick was written with no via at all",
  );
});

test("a bot's picks are recorded as bot picks, never as an absent human", async () => {
  // The number this protects: a bot's clock ALWAYS expires by design, so
  // recording its picks as 'autopick' would make a bot-filled league read as a
  // league full of people who did not turn up, which is the opposite of what
  // filling the seats achieved.
  const { room, state, db, members } = makeRoom({ humans: 1, bots: 3 });
  await room.fetch(
    new Request("https://draft-room/start", { method: "POST", headers: { "X-Draft-League-Id": "1" } }),
  );
  await runDraftToCompletion(room, state);

  const botIds = new Set(members.filter((m) => m.is_bot).map((m) => m.user_id));
  const botPicks = db.tables.picks.filter((row) => botIds.has(row.user_id));
  const humanPicks = db.tables.picks.filter((row) => !botIds.has(row.user_id));

  assert.equal(botPicks.length, 3 * SQUAD_SIZE);
  for (const row of botPicks) assert.equal(row.via, PICK_VIA.BOT, "a bot seat was not labelled as one");
  for (const row of humanPicks) {
    assert.notEqual(row.via, PICK_VIA.BOT, "a human's pick was attributed to a bot");
  }
});

test("an expired clock says queue when the manager had a shortlist and autopick when they did not", async () => {
  // The distinction the old viaQueue boolean could not draw, and the reason a
  // boolean was not enough: a manager who ranked players in advance and a
  // manager who was simply gone both used to record the same thing.
  const QUEUED_USER = 1;
  const { room, state, db } = makeRoom({ humans: 2, bots: 1, queues: queueFor(QUEUED_USER) });
  await room.fetch(
    new Request("https://draft-room/start", { method: "POST", headers: { "X-Draft-League-Id": "1" } }),
  );
  await runDraftToCompletion(room, state);

  const queued = db.tables.picks.filter((row) => row.user_id === QUEUED_USER);
  const unqueued = db.tables.picks.filter((row) => row.user_id === 2);

  assert.ok(
    queued.some((row) => row.via === PICK_VIA.QUEUE),
    "the manager with a shortlist never had a pick attributed to it",
  );
  for (const row of queued) {
    assert.ok(
      row.via === PICK_VIA.QUEUE || row.via === PICK_VIA.AUTOPICK,
      `a queued manager's clock pick was recorded as ${row.via}`,
    );
  }
  // The control. This manager queued nothing, so not one of their picks may be
  // attributed to a shortlist they never built.
  assert.equal(unqueued.length, SQUAD_SIZE);
  for (const row of unqueued) {
    assert.equal(row.via, PICK_VIA.AUTOPICK, "a manager with no queue was credited with one");
  }
});

test("a pick sent from a socket is recorded as manual", async () => {
  // The other half of the taxonomy, and the only one that means somebody was
  // actually at the keyboard. Driven through the real webSocketMessage handler
  // rather than by calling commitPick, so it proves the socket branch itself
  // reaches the right value.
  const { room, state, db } = makeRoom({ humans: 2, bots: 2 });
  await room.fetch(
    new Request("https://draft-room/start", { method: "POST", headers: { "X-Draft-League-Id": "1" } }),
  );

  const onClock = room.currentOnClockUserId();
  const ws = fakeSocket(onClock, 1);
  const player = POOL.players[0];
  await room.webSocketMessage(ws, JSON.stringify({ type: "pick", playerId: player.id }));

  assert.deepEqual(
    ws.sent.filter((message) => message.type === "error"),
    [],
    "the pick was rejected, so this test proves nothing about how it was recorded",
  );
  assert.equal(db.tables.picks.length, 1);
  assert.equal(db.tables.picks[0].user_id, onClock);
  assert.equal(db.tables.picks[0].player_id, player.id);
  assert.equal(db.tables.picks[0].via, PICK_VIA.MANUAL);
});

test("the league feed and the pick log never disagree about how a pick was made", async () => {
  // The pick row and its feed announcement ride in the SAME batch, so they can
  // only ever be written together. This is what stops them being written
  // together and saying different things: the feed is permanent history, and a
  // manager reading back a draft must not be told a story the metrics
  // contradict.
  const { room, state, db } = makeRoom({ humans: 1, bots: 2, queues: queueFor(1) });
  await room.fetch(
    new Request("https://draft-room/start", { method: "POST", headers: { "X-Draft-League-Id": "1" } }),
  );
  await runDraftToCompletion(room, state);

  const announced = db.tables.chat.filter((row) => row.event === "draft_pick");
  assert.equal(announced.length, db.tables.picks.length);
  const viaByPick = new Map(db.tables.picks.map((row) => [row.overall_pick, row.via]));
  for (const row of announced) {
    assert.equal(
      row.payload.via,
      viaByPick.get(row.payload.overallPick),
      `pick ${row.payload.overallPick} was announced differently to how it was logged`,
    );
  }
});

test("a draft rehydrated from D1 still knows how its earlier picks were made", async () => {
  // The regression the column actually fixes inside the draft room, not just
  // in the metrics. Before it, a rehydrate hardcoded viaQueue: false, so a
  // Durable Object eviction partway through a draft silently relabelled every
  // queue autopick before it as an ordinary pick in the room's own feed.
  const { room, state, db } = makeRoom({ humans: 1, bots: 1, queues: queueFor(1) });
  await room.fetch(
    new Request("https://draft-room/start", { method: "POST", headers: { "X-Draft-League-Id": "1" } }),
  );
  for (let i = 0; i < 6; i += 1) await room.alarm();

  const before = room.draft.picks.map((pick) => pick.via);
  assert.ok(before.includes(PICK_VIA.QUEUE), "the sample contained no queue pick, so it proves nothing");

  // Exactly what an eviction does: the in-memory cache is gone and the next
  // wake rebuilds it from the pick log alone.
  room.draft = null;
  await room.ensureHydrated(1);

  assert.deepEqual(
    room.draft.picks.map((pick) => pick.via),
    before,
    "a rehydrate lost or changed how the earlier picks were made",
  );
  // The derived boolean the existing browser readers still consume has to
  // survive the same round trip.
  for (const pick of room.draft.picks) {
    assert.equal(pick.viaQueue, pick.via === PICK_VIA.QUEUE);
  }
  assert.equal(db.tables.picks.length, 6);
});
