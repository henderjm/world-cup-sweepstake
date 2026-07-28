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

// -- Waiver routes, actually executed -----------------------------------------
//
// Same reasoning as the feed block above, but these routes need more than a
// session to get past their guards: the league has to read as draft-complete,
// the add target has to read as ON_WAIVERS and the drop has to read as owned.
// The one-row-fits-all stub cannot express that (the same generic row would
// make a player simultaneously owned and on the wire), so this stub dispatches
// on the SQL and on the bound parameters. Deliberately still dumb: it answers
// the handful of specific reads these two routes make and nothing else, since
// the rules themselves are covered by the pure modules under src/.
const ADD_PLAYER_ID = 7;
const DROP_PLAYER_ID = 8;

function waiverDb(seen) {
  const makeStatement = (sql) => {
    const normalised = sql.replace(/\s+/g, " ").trim();
    let bound = [];
    const statement = {
      bind: (...args) => {
        bound = args;
        return statement;
      },
      first: async () => {
        if (normalised.includes("FROM sessions s")) return { id: 1, email: "ada@example.test", name: "Ada", prefs: "{}" };
        if (normalised.includes("FROM fantasy_leagues WHERE id")) {
          return { draft_status: "complete", commissioner_user_id: 1 };
        }
        // Availability: the add target is on the wire and owned by nobody, the
        // only combination the claim path accepts.
        if (normalised.includes("FROM fantasy_rosters WHERE league_id = ?1 AND player_id = ?2")) return null;
        if (normalised.includes("FROM fantasy_waiver_wire WHERE league_id = ?1 AND player_id = ?2")) return { x: 1 };
        if (normalised.includes("FROM fantasy_players WHERE id = ?1")) {
          return { id: bound[0], name: `Player ${bound[0]}`, team: "Chelsea", position: "MID" };
        }
        if (normalised.includes("faab_remaining FROM fantasy_waiver_state")) return { faab_remaining: 50 };
        if (normalised.includes("COUNT(*) AS n")) return { n: 0 };
        return { x: 1 };
      },
      all: async () => {
        if (normalised.includes("FROM fantasy_rosters r")) {
          return { results: [{ id: DROP_PLAYER_ID, name: "Player 8", team: "Everton", position: "MID" }] };
        }
        return { results: [] };
      },
      run: async () => ({ success: true, meta: { changes: 1, last_row_id: 42 } }),
    };
    return statement;
  };
  return {
    prepare: (sql) => {
      seen.push(sql.replace(/\s+/g, " ").trim());
      return makeStatement(sql);
    },
    batch: async () => [],
  };
}

function waiverCall(path, init = {}) {
  const seen = [];
  const headers = { Authorization: `Bearer ${SESSION_TOKEN}`, ...(init.headers ?? {}) };
  const response = worker.fetch(new Request(`https://example.test${path}`, { ...init, headers }), {
    ...env,
    DB: waiverDb(seen),
  });
  return { response, seen };
}

test("GET the waivers view executes its body and reports which run a claim would land in", async () => {
  const { response, seen } = waiverCall("/fantasy/league/1/waivers");
  const resolved = await response;
  assert.equal(resolved.status, 200);
  assert.ok(
    seen.some((sql) => sql.includes("FROM fantasy_waiver_state s")),
    "the waiver-state read never ran, so this test proves nothing",
  );

  const body = await resolved.json();
  // A claim must never be ambiguous about which run it belongs to, so the
  // panel is handed the answer rather than inferring it from currentGameweek.
  assert.equal(typeof body.claimWindow.gameweek, "number");
  assert.equal(typeof body.claimWindow.deferred, "boolean");
  assert.ok(["open", "quiet", "closed"].includes(body.claimWindow.phase));
});

test("submitting a waiver claim inserts it guarded on that gameweek's run not having happened", async () => {
  const { response, seen } = waiverCall("/fantasy/league/1/waivers/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ addPlayerId: ADD_PLAYER_ID, dropPlayerId: DROP_PLAYER_ID, bid: 5 }),
  });
  const resolved = await response;
  assert.equal(resolved.status, 200);
  // The write-time half of the anti-orphan defence: without this guard a claim
  // could land on a gameweek whose run had already committed, and no later
  // tick would ever look at it again.
  assert.ok(
    seen.some(
      (sql) =>
        sql.startsWith("INSERT INTO fantasy_waivers") &&
        sql.includes("WHERE NOT EXISTS (SELECT 1 FROM fantasy_waiver_runs WHERE league_id = ?1 AND gameweek = ?6)"),
    ),
    "the claim insert was not guarded on the run ledger",
  );

  const body = await resolved.json();
  assert.equal(body.status, "pending");
  assert.equal(typeof body.gameweek, "number");
  assert.equal(typeof body.deferred, "boolean");
});

test("GET the lineup reports each club's fixture count so a blank or double gameweek is visible", async () => {
  const { response } = waiverCall("/fantasy/league/1/lineup");
  const resolved = await response;
  assert.equal(resolved.status, 200);
  const body = await resolved.json();
  // null (not {}) with no reachable feed: "we could not look" and "no club has
  // a fixture" must not render as the same thing.
  assert.ok(Object.hasOwn(body, "clubFixtures"));
});

// -- The waiver run's lock and roll-forward, actually executed ----------------
//
// runLeagueWaiverRun is not exported, and with no bindings the cron's waiver
// pass exits at "no gameweek has settled yet", so nothing in this file reached
// it. FANTASY_GAMEWEEK_OVERRIDE (the existing dev escape hatch, see
// currentFantasyGameweek) walks the clock forward to a settled gameweek without
// needing a real feed, which is enough to run the pass end to end against a
// recording stub. Without this the lease and the roll-forward, the two pieces
// of the boundary-race fix, would ship with no test entering them at all.
function cronDb(seen, batches) {
  const make = (sql) => {
    const normalised = sql.replace(/\s+/g, " ").trim();
    const statement = {
      sql: normalised,
      bind: (...args) => {
        statement.bound = args;
        return statement;
      },
      // No run marker for this gameweek yet, and no stored waiver settings, so
      // the pass takes its full path rather than short-circuiting.
      first: async () => null,
      all: async () => {
        if (normalised.includes("FROM fantasy_leagues WHERE draft_status = 'complete'")) {
          return { results: [{ id: 1 }] };
        }
        if (normalised.includes("FROM fantasy_league_members WHERE league_id")) {
          return { results: [{ user_id: 1, draft_position: 1 }] };
        }
        return { results: [] };
      },
      run: async () => ({ success: true, meta: { changes: 1, last_row_id: 1 } }),
    };
    return statement;
  };
  return {
    prepare: (sql) => {
      const statement = make(sql);
      seen.push(statement.sql);
      return statement;
    },
    batch: async (statements) => {
      batches.push(statements.map((statement) => statement.sql));
      return [];
    },
  };
}

test("a waiver run takes a lease, and its batch rolls late claims forward before releasing it", async () => {
  const seen = [];
  const batches = [];
  const pending = [];
  await worker.scheduled(
    { cron: "* * * * *" },
    { ...env, FANTASY_GAMEWEEK_OVERRIDE: "12", DB: cronDb(seen, batches) },
    { waitUntil: (promise) => pending.push(promise) },
  );
  await Promise.all(pending);

  assert.ok(
    seen.some((sql) => sql.startsWith("INSERT INTO fantasy_waiver_locks")),
    "the run never tried to take a lease, so two overlapping ticks would both do the work",
  );

  const runBatch = batches.find((sqls) => sqls.some((sql) => sql.startsWith("INSERT INTO fantasy_waiver_runs")));
  assert.ok(runBatch, "the run never built its committing batch");
  assert.equal(runBatch[0], "INSERT INTO fantasy_waiver_runs (league_id, gameweek) VALUES (?1, ?2)");

  // Order is the whole point of these two. The roll-forward must come after
  // every per-claim status update, so it can only catch claims the run never
  // saw; the lease release must be inside the committing transaction, so the
  // lock is given up exactly when the run becomes visible.
  const rollForward = runBatch.findIndex((sql) => sql.startsWith("UPDATE fantasy_waivers SET gameweek"));
  const release = runBatch.findIndex((sql) => sql.startsWith("DELETE FROM fantasy_waiver_locks"));
  assert.ok(rollForward >= 0, "a claim landing mid-run would be orphaned pending forever");
  assert.equal(release, runBatch.length - 1);
  assert.ok(rollForward < release);
  assert.ok(
    runBatch[rollForward].includes("AND gameweek = ?2 AND status = 'pending'"),
    "the roll-forward must be scoped to still-pending claims for the settled gameweek only",
  );
});
