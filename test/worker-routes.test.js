import assert from "node:assert/strict";
import test from "node:test";

import worker from "../worker/worker.js";

// Smoke tests for the Worker's route dispatch.
//
// These exist because of a real regression that shipped: renaming `matchKnown`
// to `findKnownMatch` updated the definition and one of its two call sites, and
// the survivor sat inside handleBanter. Every /banter request then threw a
// ReferenceError. Nothing caught it. `node --check` only parses, the pure
// modules under src/ were all green, and there was no test that ever entered a
// Worker route.
//
// The point here is deliberately narrow: prove each route is REACHABLE and
// returns a Response rather than throwing on an undefined identifier. Route
// behaviour proper belongs with the pure modules, which is where it already is.
// A ReferenceError inside a route only surfaces when that route runs, so the
// only guard is to run them.
//
// Every binding is absent on purpose. Each route is supposed to degrade to a
// clear status code when its binding is missing (501/503), which means this
// suite needs no D1, no KV, no Durable Object and no network, and it exercises
// the degradation paths at the same time.

// A stub D1 binding, and it is load-bearing rather than incidental.
//
// Every route guards on `if (!env.DB) return ...` before doing anything, so a
// bindings-free env exits each handler on its first line and proves nothing.
// The first version of this file made exactly that mistake: it passed happily
// with the ReferenceError still in the code, because the banter handler
// returned 503 two lines above the bug. A stub gets execution past the guards
// and into the body, which is the only place these faults live.
//
// Deliberately dumb: no storage, no SQL, just the shape D1 exposes. Anything
// smarter would be a second implementation to keep in sync, and route
// behaviour is already covered by the pure modules under src/.
function stubDb() {
  const statement = {
    bind: () => statement,
    first: async () => null,
    all: async () => ({ results: [] }),
    run: async () => ({ success: true }),
  };
  return { prepare: () => statement, batch: async () => [] };
}

const env = {
  API_FOOTBALL_KEY: "test-key",
  API_FOOTBALL_COMPETITIONS: "PL:2026",
  DB: stubDb(),
};

const call = (path, init = {}) => worker.fetch(new Request(`https://example.test${path}`, init), env);

// Any 5xx that is not one of the deliberate "binding missing" codes means the
// route blew up rather than degraded. 502 is included because the fetch
// handler's own catch turns an upstream failure into one, which is expected
// here: there is no real API-Football behind these calls.
const DEGRADED = new Set([501, 502, 503]);

const ROUTES = [
  ["GET", "/health"],
  ["GET", "/health/draft-ready"],
  ["GET", "/"],
  ["GET", "/me"],
  ["GET", "/fantasy/leagues"],
  ["GET", "/fantasy/league/1"],
  ["GET", "/fantasy/league/1/lineup"],
  ["GET", "/fantasy/league/1/draft/queue"],
  ["GET", "/fantasy/league/1/matchup"],
  ["GET", "/fantasy/league/1/standings"],
  ["GET", "/fantasy/league/1/waivers"],
  ["GET", "/fantasy/league/1/chat"],
  ["POST", "/fantasy/league/1/chat"],
  ["GET", "/analysis/12345"],
  ["GET", "/banter/12345"],
  ["GET", "/match/12345"],
  ["GET", "/PL/live"],
  ["GET", "/nope-not-a-route"],
];

for (const [method, path] of ROUTES) {
  test(`${method} ${path} returns a Response instead of throwing`, async () => {
    const response = await call(path, { method });
    assert.ok(response instanceof Response, "handler did not return a Response");
    assert.equal(typeof response.status, "number");
    // A 500 is the tell for an unhandled programming error. The deliberate
    // "not configured" paths use 501/503, and 502 is the upstream-unavailable
    // path, which is legitimate with no real API behind this.
    assert.notEqual(response.status, 500, `${path} returned 500, which means it threw internally`);
  });
}

test("the banter route specifically resolves its match lookup", async () => {
  // The exact regression. Before the fix this threw a ReferenceError on
  // matchKnown, escaping the fetch handler's try/catch entirely.
  const response = await call("/banter/12345");
  assert.ok(response instanceof Response);
  assert.ok(
    DEGRADED.has(response.status) || response.status === 404,
    `banter degraded badly: ${response.status}`,
  );
});

test("POST routes reject cleanly without a session rather than throwing", async () => {
  const posts = [
    "/auth/logout",
    "/follows/toggle",
    "/prefs",
    "/fantasy/leagues",
    "/fantasy/leagues/join",
    "/fantasy/league/1/lineup",
    "/fantasy/league/1/draft/queue",
    "/fantasy/league/1/waivers/claim",
  ];
  for (const path of posts) {
    const response = await call(path, {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    assert.ok(response instanceof Response, `${path} did not return a Response`);
    assert.notEqual(response.status, 500, `${path} returned 500, which means it threw internally`);
  }
});

// -- League feed routes, actually executed ------------------------------------
//
// The entries in ROUTES above prove the feed routes are dispatched, but they
// stop at the 401: every fantasy route resolves a session before it does
// anything, so an unauthenticated call never reaches a single SQL statement
// (verified: zero prepare() calls). That is precisely the short-circuit this
// file's header warns about, and it would hide a ReferenceError in the feed
// body exactly as it once hid one in handleBanter.
//
// So these tests carry a session. The stub answers first() with a row, which
// satisfies both the session lookup and the membership check, and records the
// SQL it was handed so a test can assert execution genuinely got past the
// guards rather than trusting a 200.
function authedDb(seen) {
  const statement = {
    bind: () => statement,
    // One generic row serves the session lookup (needs id), the membership
    // check and the message-ownership check (both need only truthiness).
    first: async () => ({ id: 1, email: "ada@example.test", name: "Ada", prefs: "{}", x: 1 }),
    all: async () => ({ results: [] }),
    // changes: 0 makes the reaction toggle take its insert branch after the
    // delete, so one call covers both statements in that path.
    run: async () => ({ success: true, meta: { changes: 0, last_row_id: 5 } }),
  };
  return {
    prepare: (sql) => {
      seen.push(sql.replace(/\s+/g, " ").trim());
      return statement;
    },
    batch: async () => [],
  };
}

// Matches bearerToken's own regex in worker.js; a token it rejects would send
// us straight back to the 401 this block exists to get past.
const SESSION_TOKEN = "a".repeat(40);

function authedCall(path, init = {}) {
  const seen = [];
  const headers = { Authorization: `Bearer ${SESSION_TOKEN}`, ...(init.headers ?? {}) };
  const response = worker.fetch(new Request(`https://example.test${path}`, { ...init, headers }), {
    ...env,
    DB: authedDb(seen),
  });
  return { response, seen };
}

test("GET the league feed executes its body rather than stopping at a guard", async () => {
  const { response, seen } = authedCall("/fantasy/league/1/chat");
  const resolved = await response;
  assert.equal(resolved.status, 200);
  // The anti-short-circuit assertion: the feed read and its reaction rollup
  // both have to have run, not just the session and membership lookups.
  assert.ok(
    seen.some((sql) => sql.includes("FROM fantasy_chat_messages m")),
    "the feed read never ran, so this test proves nothing",
  );
  assert.ok(
    seen.some((sql) => sql.includes("FROM fantasy_chat_reactions r")),
    "the reaction rollup never ran",
  );

  const body = await resolved.json();
  assert.ok(Array.isArray(body.entries));
  assert.equal(body.viewerUserId, 1);
});

test("posting a feed message reaches the cap check and the insert", async () => {
  const { response, seen } = authedCall("/fantasy/league/1/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "message", text: "unlucky mate" }),
  });
  assert.equal((await response).status, 200);
  assert.ok(seen.some((sql) => sql.includes("SELECT COUNT(*) AS n FROM fantasy_chat_messages")), "cap check skipped");
  assert.ok(seen.some((sql) => sql.startsWith("INSERT INTO fantasy_chat_messages")), "message never inserted");
});

test("reacting to a feed message verifies the message belongs to the league", async () => {
  const { response, seen } = authedCall("/fantasy/league/1/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "react", messageId: 5, emoji: "🔥" }),
  });
  assert.equal((await response).status, 200);
  // Message ids are globally sequential, so the league scoping on this lookup
  // is what stops a member of one league reacting into another's feed.
  assert.ok(
    seen.some((sql) => sql.includes("FROM fantasy_chat_messages WHERE id = ?1 AND league_id = ?2")),
    "the reaction target was never scoped to the league",
  );
  assert.ok(seen.some((sql) => sql.startsWith("DELETE FROM fantasy_chat_reactions")), "toggle never ran");
});

test("the feed rejects a bad action and an emoji outside the allowlist", async () => {
  const bad = await authedCall("/fantasy/league/1/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "drop-tables" }),
  }).response;
  assert.equal(bad.status, 400);

  const emoji = await authedCall("/fantasy/league/1/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "react", messageId: 5, emoji: "🦄" }),
  }).response;
  assert.equal(emoji.status, 400);
});

test("an OPTIONS preflight is answered without touching any binding", async () => {
  const response = await call("/fantasy/leagues", { method: "OPTIONS" });
  assert.equal(response.status, 200);
});

test("the scheduled handler runs every cron pass without throwing, even with no bindings", async () => {
  // runCronPass isolates each pass, so this asserts the isolation actually
  // holds: with nothing configured, every pass should fail inside its own
  // guard rather than escaping and killing the ones behind it.
  const pending = [];
  const ctx = { waitUntil: (promise) => pending.push(promise) };
  await worker.scheduled({ cron: "* * * * *" }, env, ctx);
  await assert.doesNotReject(Promise.all(pending));
});
