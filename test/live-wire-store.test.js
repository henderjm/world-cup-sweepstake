import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { WIRE_AI_PER_TICK, handleLiveWire, runLiveWirePass } from "../worker/liveWireStore.js";

// A D1-shaped adapter over a real SQLite database, so the SQL itself is under
// test (unique keys, the guarded claim, the cursor) rather than a mock's idea of it.
function d1() {
  const sqlite = new DatabaseSync(":memory:");
  const schema = readFileSync(new URL("../worker/migrations/011-live-wire.sql", import.meta.url), "utf8");
  sqlite.exec(schema);
  const statement = (sql) => {
    let args = [];
    const self = {
      bind: (...values) => { args = values.map(value => value === undefined ? null : value); return self; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
      first: async () => sqlite.prepare(sql).get(...args) ?? null,
    };
    return self;
  };
  return {
    sqlite,
    prepare: statement,
    batch: async (statements) => {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const item of statements) results.push(await item.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

const KICKOFF = Date.parse("2026-10-20T19:00:00.000Z");
const COMPS = [{ code: "CL", season: "2026" }];
const quiet = { log() {}, error() {} };

function harness() {
  const db = d1();
  const state = {
    match: { id: 7, utcDate: new Date(KICKOFF).toISOString(), status: "IN_PLAY", providerStatus: "1H", minute: 5,
      homeTeam: "Liverpool", awayTeam: "Villarreal", score: { home: 0, away: 0 }, penalties: null },
    detail: { goals: [], cards: [], subs: [], score: {} },
    calls: [],
    reply: "Anfield erupts and the tie tilts.",
  };
  const client = {
    messages: {
      create: async (params) => {
        state.calls.push(params);
        return { stop_reason: "end_turn", usage: {}, content: [{ type: "text", text: JSON.stringify({ line: state.reply }) }] };
      },
    },
  };
  const tick = (minutesAfterKickoff, extra = {}) => runLiveWirePass({
    db,
    competitions: COMPS,
    getLive: async () => ({ matches: [state.match], standings: [] }),
    fetchDetail: async () => state.detail,
    isDetailTrusted: () => true,
    createClient: () => client,
    now: KICKOFF + minutesAfterKickoff * 60_000,
    log: quiet,
    ...extra,
  });
  const rows = () => db.sqlite.prepare("SELECT item_key, kind, ai_state, ai_line FROM live_wire_items ORDER BY id").all();
  return { db, state, tick, rows };
}

test("a match plays out on the wire: each event once, AI only on the big fresh ones", async () => {
  const { state, tick, rows } = harness();
  await tick(5);
  await tick(6);
  assert.deepEqual(rows().map(row => row.item_key), ["ko:7"]);

  state.match = { ...state.match, minute: 24, score: { home: 1, away: 0 } };
  state.detail.goals = [{ minute: 23, injuryTime: null, type: "REGULAR", team: "Liverpool", scorerId: 11, scorer: "Salah", assist: "Szoboszlai" }];
  state.detail.cards = [{ minute: 20, team: "Villarreal", playerId: 4, player: "Parejo", card: "YELLOW" }];
  await tick(24);
  await tick(25);

  const after = rows();
  assert.deepEqual(after.map(row => row.item_key), ["ko:7", "g:7:home:1", "c:7:4:YELLOW"]);
  const goalRow = after.find(row => row.kind === "goal");
  assert.equal(goalRow.ai_state, "done");
  assert.equal(goalRow.ai_line, "Anfield erupts and the tie tilts.");
  assert.equal(after.find(row => row.kind === "card").ai_state, null, "a yellow is template-only");
  assert.equal(state.calls.length, 1, "one model call for one goal, however many ticks see it");
  assert.equal(state.calls[0].model, "claude-haiku-5-5");
});

test("a goal ruled out keeps its row, frees the slot and adds a ruled-out item", async () => {
  const { state, tick, rows } = harness();
  state.match = { ...state.match, minute: 24, score: { home: 1, away: 0 } };
  state.detail.goals = [{ minute: 23, type: "REGULAR", team: "Liverpool", scorerId: 11, scorer: "Salah" }];
  await tick(24);

  state.match = { ...state.match, minute: 27, score: { home: 0, away: 0 } };
  state.detail.goals = [];
  await tick(27);
  let keys = rows().map(row => row.item_key);
  assert.ok(keys.some(key => /^g:7:home:1#\d+$/.test(key)), "original renamed, not deleted");
  assert.ok(keys.some(key => /^x:g:7:home:1#\d+$/.test(key)));

  // The next real goal takes the freed first slot.
  state.match = { ...state.match, minute: 60, providerStatus: "2H", score: { home: 1, away: 0 } };
  state.detail.goals = [{ minute: 59, type: "REGULAR", team: "Liverpool", scorerId: 9, scorer: "Gakpo" }];
  await tick(75);
  keys = rows().map(row => row.item_key);
  assert.ok(keys.includes("g:7:home:1"));
});

test("a backfilled evening is stored but never sent to the model", async () => {
  const { state, tick, rows } = harness();
  state.match = { ...state.match, minute: 70, providerStatus: "2H", score: { home: 2, away: 0 } };
  state.detail.goals = [
    { minute: 10, type: "REGULAR", team: "Liverpool", scorerId: 11, scorer: "Salah" },
    { minute: 40, type: "REGULAR", team: "Liverpool", scorerId: 11, scorer: "Salah" },
  ];
  await tick(85);
  assert.equal(state.calls.length, 0);
  assert.ok(rows().filter(row => row.kind === "goal").every(row => row.ai_state === null));
});

test("an untrusted detail read moves status items only and rules nothing out", async () => {
  const { state, tick, rows } = harness();
  state.match = { ...state.match, minute: 24, score: { home: 1, away: 0 } };
  state.detail.goals = [{ minute: 23, type: "REGULAR", team: "Liverpool", scorerId: 11, scorer: "Salah" }];
  await tick(24);
  state.detail = { goals: [], cards: [], subs: [] };
  state.match = { ...state.match, minute: 45, status: "PAUSED", providerStatus: "HT", score: { home: 0, away: 0 } };
  await tick(47, { isDetailTrusted: () => false });
  const keys = rows().map(row => row.item_key);
  assert.ok(keys.includes("g:7:home:1"), "nothing retired on a failed read");
  assert.ok(keys.includes("ht:7"));
});

test("a line stating an invented figure is rejected and the template stands", async () => {
  const { state, tick, rows } = harness();
  state.reply = "Salah's 214th goal for the club.";
  state.match = { ...state.match, minute: 24, score: { home: 1, away: 0 } };
  state.detail.goals = [{ minute: 23, type: "REGULAR", team: "Liverpool", scorerId: 11, scorer: "Salah" }];
  await tick(24);
  const goalRow = rows().find(row => row.kind === "goal");
  assert.equal(goalRow.ai_state, "rejected");
  assert.equal(goalRow.ai_line, null);
});

test("model calls are capped per tick", async () => {
  const { state, tick } = harness();
  const goals = Array.from({ length: WIRE_AI_PER_TICK + 3 }, (_, index) =>
    ({ minute: 20, type: "REGULAR", team: "Liverpool", scorerId: index, scorer: `P${index}` }));
  state.match = { ...state.match, minute: 22, score: { home: goals.length, away: 0 } };
  state.detail.goals = goals;
  await tick(22);
  assert.equal(state.calls.length, WIRE_AI_PER_TICK);
  await tick(23);
  assert.equal(state.calls.length, goals.length, "the rest are written next tick");
});

test("the read route pages by cursor and resends a row whose AI line landed later", async () => {
  const { db, state, tick } = harness();
  const json = (body, status, headers) => ({ body, status, headers });
  const env = { DB: db };
  await tick(5);
  const first = await handleLiveWire(new Request("https://x/wire?day=2026-10-20"), env, {}, json, KICKOFF);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.items.map(item => item.key), ["ko:7"]);

  state.match = { ...state.match, minute: 24, score: { home: 1, away: 0 } };
  state.detail.goals = [{ minute: 23, type: "REGULAR", team: "Liverpool", scorerId: 11, scorer: "Salah" }];
  await tick(24);
  const next = await handleLiveWire(new Request(`https://x/wire?day=2026-10-20&since=${first.body.cursor}`), env, {}, json, KICKOFF);
  const goal = next.body.items.find(item => item.kind === "goal");
  assert.equal(goal.ai, "Anfield erupts and the tie tilts.");
  assert.equal(goal.aiPending, false);

  const missing = await handleLiveWire(new Request("https://x/wire?day=nope"), env, {}, json);
  assert.equal(missing.status, 400);
  assert.equal((await handleLiveWire(new Request("https://x/wire"), {}, {}, json)).status, 501);
});

test("an unapplied migration reads as an empty wire, not an error", async () => {
  const json = (body, status) => ({ body, status });
  const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => { throw new Error("D1_ERROR: no such table: live_wire_items"); } }) }) } };
  const response = await handleLiveWire(new Request("https://x/wire?day=2026-10-20"), env, {}, json);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.items, []);
});
