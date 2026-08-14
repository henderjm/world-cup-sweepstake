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

// -- The stubbed upstream, installed for the WHOLE file -----------------------
//
// This used to be per-test, which left every other test in the file making a
// real request to v3.football.api-sports.io. Nothing was billed (the key here
// is bogus and earns a 403) but it made the suite network-dependent and slow:
// 16 real outbound requests per run, and a red suite on a train.
//
// So the default stub is installed once at module load and never uninstalled.
// stubUpstream() still exists for tests that need a specific endpoint to
// misbehave; it layers over the default and restores back to it.
const UPSTREAM = "https://v3.football.api-sports.io";

// One fixture id per test that opens a match drawer, rather than one shared id.
// The Worker memoises upstream payloads per URL for the window the call site
// declared (src/apiCache.js), so two tests sharing an id would have the second
// read the payload the first one cached instead of its own stub. That is
// correct in production and useless in a test trying to break one endpoint.
const FIXTURE_IDS = {
  usage: 1557367,
  cacheHit: 1557368,
  unplayed: 1557369,
  supplementary: 1557370,
  fixtureFailure: 1557371,
  limiter: 1557372,
  // The budget guard rail's own fixtures. See the block at the very end of this
  // file for why those tests must run last.
  budgetConserve: 1557373,
  budgetCritical: 1557374,
};
const UPCOMING_ID = FIXTURE_IDS.usage;

function apiResponse(body, { cacheStatus = "MISS", remaining = 149000 } = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cf-cache-status": cacheStatus,
      "x-ratelimit-requests-limit": "150000",
      "x-ratelimit-requests-remaining": String(remaining),
    },
  });
}

// A fixture three weeks out: no lineups, no events, no player stats, which is
// exactly the state the 502 used to be reported for.
const upcomingFixture = (id) => ({
  fixture: {
    id,
    date: new Date(Date.now() + 21 * 24 * 3600 * 1000).toISOString(),
    status: { short: "NS", elapsed: null },
    venue: { name: "Emirates Stadium", city: "London" },
    referee: null,
  },
  league: { round: "Regular Season - 2" },
  teams: {
    home: { id: 42, name: "Arsenal", logo: "h.png" },
    away: { id: 1076, name: "Coventry City", logo: "a.png" },
  },
  goals: { home: null, away: null },
  score: { halftime: { home: null, away: null }, penalty: { home: null, away: null } },
});

// The season schedule carries EVERY test's fixture id. The schedule URL is one
// URL for all of them and is memoised for six hours, so whichever test warms it
// first decides what every later id validation can find.
const scheduleFixtures = Object.values(FIXTURE_IDS).map(upcomingFixture);

const emptyPayload = { errors: [], results: 0, paging: { current: 1, total: 1 }, response: [] };

function respondFor(path) {
  if (path.startsWith("/fixtures/")) return apiResponse(emptyPayload);
  if (path.startsWith("/standings")) return apiResponse({ errors: [], response: [] });
  if (path.startsWith("/fixtures?id=")) {
    const id = Number(path.replace("/fixtures?id=", ""));
    const match = scheduleFixtures.filter((entry) => entry.fixture.id === id);
    return apiResponse({ errors: [], results: match.length, response: match });
  }
  if (path.startsWith("/fixtures")) {
    return apiResponse({ errors: [], results: scheduleFixtures.length, response: scheduleFixtures });
  }
  throw new Error(`unstubbed upstream ${path}`);
}

// Anything that is not API-Football (the player-pool seed reads the site
// origin) is answered rather than allowed out, so the file makes no real
// requests at all.
function installUpstream(broken = {}) {
  globalThis.fetch = async (input) => {
    const url = String(input?.url ?? input);
    if (!url.startsWith(UPSTREAM)) {
      return new Response(JSON.stringify({ players: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const path = url.replace(UPSTREAM, "");
    for (const [prefix, make] of Object.entries(broken)) {
      if (path.startsWith(prefix)) return make();
    }
    return respondFor(path);
  };
}

installUpstream();

// `broken` maps a path prefix to the Response that path should give instead.
// Restores to the file-wide default, not to real fetch.
function stubUpstream(broken = {}) {
  installUpstream(broken);
  return () => installUpstream();
}

const call = (path, init = {}) => worker.fetch(new Request(`https://example.test${path}`, init), env);

// Any 5xx that is not one of the deliberate "binding missing" codes means the
// route blew up rather than degraded. 502 is included because the fetch
// handler's own catch turns an upstream failure into one, which is expected
// here: there is no real API-Football behind these calls.
const DEGRADED = new Set([501, 502, 503]);

const ROUTES = [
  ["GET", "/health"],
  ["GET", "/health/draft-ready"],
  ["GET", "/health/quota"],
  ["GET", "/"],
  ["GET", "/me"],
  ["GET", "/fantasy/leagues"],
  ["GET", "/fantasy/league/1"],
  ["GET", "/fantasy/league/1/lineup"],
  ["GET", "/fantasy/league/1/draft/queue"],
  ["GET", "/fantasy/league/1/draft/recap"],
  ["GET", "/fantasy/league/1/matchup"],
  ["GET", "/fantasy/league/1/schedule"],
  ["GET", "/fantasy/league/1/standings"],
  ["GET", "/fantasy/league/1/waivers"],
  ["GET", "/fantasy/league/1/chat"],
  ["POST", "/fantasy/league/1/chat"],
  ["GET", "/fantasy/invite/ABCDEF0123"],
  ["POST", "/fantasy/league/1/bots"],
  ["DELETE", "/fantasy/league/1/bots/2"],
  ["POST", "/fantasy/league/1/autopilot/2"],
  ["DELETE", "/fantasy/league/1/autopilot/2"],
  ["POST", "/fantasy/league/1/champion"],
  ["DELETE", "/fantasy/league/1/champion"],
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
    "/fantasy/league/1/bots",
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

// -- Dead-team autopilot routes, actually executed ----------------------------
//
// Same anti-short-circuit discipline as the blocks around it. What is being
// proved here is the authorization shape, because the failure mode this
// feature could introduce is "any member can hand any other member's team to
// the bots", and the looser one, "a manager cannot take their own team back".

function autopilotDb(seen, { commissionerUserId = 1, draftStatus = "complete", targetIsBot = false, isMember = true } = {}) {
  const make = (sql) => {
    const normalised = sql.replace(/\s+/g, " ").trim();
    let bound = [];
    const statement = {
      bind: (...args) => {
        bound = args;
        return statement;
      },
      first: async () => {
        if (normalised.includes("FROM sessions s")) {
          return { id: 1, email: "ada@example.test", name: "Ada", prefs: "{}" };
        }
        if (normalised.includes("FROM fantasy_leagues WHERE id")) {
          return { commissioner_user_id: commissionerUserId, draft_status: draftStatus };
        }
        if (normalised.includes("FROM fantasy_league_members m JOIN users u")) {
          return isMember
            ? { user_id: bound[1], autopilot: 1, name: "Bo", email: "bo@example.test", is_bot: targetIsBot ? 1 : 0 }
            : null;
        }
        if (normalised.startsWith("SELECT name, email FROM users")) return { name: "Bo", email: "bo@example.test" };
        return null;
      },
      all: async () => ({ results: [] }),
      run: async () => ({ success: true, meta: { changes: 1 } }),
    };
    return statement;
  };
  return {
    prepare: (sql) => {
      seen.push(sql.replace(/\s+/g, " ").trim());
      return make(sql);
    },
    batch: async () => [],
  };
}

function autopilotCall(method, path, dbOptions) {
  const seen = [];
  const response = worker.fetch(
    new Request(`https://example.test${path}`, { method, headers: { Authorization: `Bearer ${SESSION_TOKEN}` } }),
    { ...env, DB: autopilotDb(seen, dbOptions) },
  );
  return { response, seen };
}

test("the commissioner can put an abandoned team on autopilot", async () => {
  const { response, seen } = autopilotCall("POST", "/fantasy/league/1/autopilot/2");
  assert.equal((await response).status, 200);
  assert.ok(
    seen.some((sql) => sql.startsWith("UPDATE fantasy_league_members SET autopilot = 1")),
    "the flag was never written, so this test proves nothing",
  );
  // Announced in the feed, never quiet: this is also how the absent manager
  // finds out when they come back.
  assert.ok(
    seen.some((sql) => sql.startsWith("INSERT INTO fantasy_chat_messages")),
    "a team started playing itself without telling the league",
  );
});

test("an ordinary member cannot put somebody else's team on autopilot", async () => {
  // The failure mode this feature could have introduced. The session is user 1;
  // the commissioner is user 99.
  const { response, seen } = autopilotCall("POST", "/fantasy/league/1/autopilot/2", { commissionerUserId: 99 });
  assert.equal((await response).status, 403);
  assert.equal(
    seen.some((sql) => sql.startsWith("UPDATE fantasy_league_members SET autopilot")),
    false,
    "a non-commissioner still wrote the flag",
  );
});

test("a manager can take their own team back off autopilot without the commissioner", async () => {
  // Reversibility must not depend on the commissioner being reachable.
  const { response, seen } = autopilotCall("DELETE", "/fantasy/league/1/autopilot/1", { commissionerUserId: 99 });
  assert.equal((await response).status, 200);
  assert.ok(
    seen.some((sql) => sql.startsWith("UPDATE fantasy_league_members SET autopilot = 0")),
    "the flag was never cleared",
  );
});

test("nobody can take a third party's team off autopilot", async () => {
  // Disabling is looser than enabling, but not unlimited: user 1 is neither
  // the commissioner nor the owner of seat 2.
  const { response } = autopilotCall("DELETE", "/fantasy/league/1/autopilot/2", { commissionerUserId: 99 });
  assert.equal((await response).status, 403);
});

test("autopilot refuses a seat that is already a bot, and a league that has not drafted", async () => {
  // Flagging a bot seat would be a no-op that reads in the feed as though a
  // person had gone missing.
  const bot = await autopilotCall("POST", "/fantasy/league/1/autopilot/2", { targetIsBot: true }).response;
  assert.equal(bot.status, 400);

  // Before the draft an empty seat is filled with a real bot member instead,
  // which is a different mechanism with different consequences.
  const pending = await autopilotCall("POST", "/fantasy/league/1/autopilot/2", { draftStatus: "pending" }).response;
  assert.equal(pending.status, 400);

  const stranger = await autopilotCall("POST", "/fantasy/league/1/autopilot/2", { isMember: false }).response;
  assert.equal(stranger.status, 404);
});

// -- The defending champion, actually executed --------------------------------
//
// Same anti-short-circuit discipline as the autopilot block above. What is
// being proved is the authorization shape: the failure mode this feature could
// introduce is "any member can hand the league's trophy to anyone", and the
// second one is storing an id belonging to somebody who is not in the league,
// which would save cleanly and then never match a member again.

function championDb(seen, { commissionerUserId = 1, draftStatus = "complete", members, previousWinner = null } = {}) {
  const rows = members ?? [
    { user_id: 1, team_name: null, name: "Ada", email: "ada@example.test", is_bot: 0 },
    { user_id: 2, team_name: "Rory's XI", name: "Rory", email: "rory@example.test", is_bot: 0 },
    { user_id: 7, team_name: null, name: "Bot Casillas", email: "bot@example.test", is_bot: 1 },
  ];
  const make = (sql) => {
    const normalised = sql.replace(/\s+/g, " ").trim();
    const statement = {
      bind: () => statement,
      first: async () => {
        if (normalised.includes("FROM sessions s")) {
          return { id: 1, email: "ada@example.test", name: "Ada", prefs: "{}" };
        }
        if (normalised.includes("FROM fantasy_leagues WHERE id")) {
          return {
            id: 1,
            commissioner_user_id: commissionerUserId,
            draft_status: draftStatus,
            previous_winner_user_id: previousWinner,
          };
        }
        return null;
      },
      all: async () => ({ results: rows }),
      run: async () => ({ success: true, meta: { changes: 1 } }),
    };
    return statement;
  };
  return {
    prepare: (sql) => {
      seen.push(sql.replace(/\s+/g, " ").trim());
      return make(sql);
    },
    batch: async () => [],
  };
}

function championCall(method, body, dbOptions) {
  const seen = [];
  const response = worker.fetch(
    new Request("https://example.test/fantasy/league/1/champion", {
      method,
      headers: { Authorization: `Bearer ${SESSION_TOKEN}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...env, DB: championDb(seen, dbOptions) },
  );
  return { response, seen };
}

test("the commissioner can name last season's winner, and the league is told", async () => {
  const { response, seen } = championCall("POST", { userId: 2 });
  const resolved = await response;
  assert.equal(resolved.status, 200);
  assert.deepEqual(await resolved.json(), { previousWinnerUserId: 2 });
  assert.ok(
    seen.some((sql) => sql.startsWith("UPDATE fantasy_leagues SET previous_winner_user_id = ?2")),
    "the champion was never written, so this test proves nothing",
  );
  // A trophy appearing beside a name unannounced is the version that starts an
  // argument in the group chat rather than settling one.
  assert.ok(
    seen.some((sql) => sql.startsWith("INSERT INTO fantasy_chat_messages")),
    "the league was never told who the champion is",
  );
});

test("an ordinary member cannot name the champion", async () => {
  // The session is user 1; the commissioner is user 99.
  const { response, seen } = championCall("POST", { userId: 1 }, { commissionerUserId: 99 });
  assert.equal((await response).status, 403);
  assert.equal(
    seen.some((sql) => sql.startsWith("UPDATE fantasy_leagues SET previous_winner_user_id")),
    false,
    "a non-commissioner still wrote the champion",
  );
});

test("the champion must be a member of this league, and must not be a bot", async () => {
  const stranger = championCall("POST", { userId: 404 });
  assert.equal((await stranger.response).status, 400);
  assert.equal(
    stranger.seen.some((sql) => sql.startsWith("UPDATE fantasy_leagues SET previous_winner_user_id")),
    false,
    "an id belonging to nobody in this league was stored",
  );

  // A bot seat is created for this league while it is pending, so it cannot
  // have won a season that predates the league.
  const bot = championCall("POST", { userId: 7 });
  assert.equal((await bot.response).status, 400);

  for (const body of [{}, { userId: null }, { userId: "nobody" }]) {
    assert.equal((await championCall("POST", body).response).status, 400, JSON.stringify(body));
  }
});

test("naming the champion is allowed after the draft, unlike filling a seat with a bot", async () => {
  // The deliberate difference from the bot routes: this records history, it
  // does not change who plays, so a commissioner who only thinks of it in
  // October must still be able to do it.
  for (const draftStatus of ["pending", "drafting", "complete"]) {
    const { response } = championCall("POST", { userId: 2 }, { draftStatus });
    assert.equal((await response).status, 200, draftStatus);
  }
});

test("clearing the champion is idempotent, and only says so when there was one", async () => {
  const had = championCall("DELETE", undefined, { previousWinner: 2 });
  const resolved = await had.response;
  assert.equal(resolved.status, 200);
  assert.deepEqual(await resolved.json(), { previousWinnerUserId: null });
  assert.ok(had.seen.some((sql) => sql.startsWith("INSERT INTO fantasy_chat_messages")));

  // Nothing to clear: still a 200 (the caller gets the end state they asked
  // for), but no feed line about an event that did not happen.
  const hadNot = championCall("DELETE", undefined, { previousWinner: null });
  assert.equal((await hadNot.response).status, 200);
  assert.equal(
    hadNot.seen.some((sql) => sql.startsWith("INSERT INTO fantasy_chat_messages")),
    false,
    "the feed announced a champion being cleared when there was none",
  );
});

test("an ordinary member cannot clear the champion either", async () => {
  const { response, seen } = championCall("DELETE", undefined, { commissionerUserId: 99, previousWinner: 2 });
  assert.equal((await response).status, 403);
  assert.equal(
    seen.some((sql) => sql.includes("previous_winner_user_id = NULL")),
    false,
  );
});

// -- The post-draft recap route, actually executed ----------------------------
//
// Same anti-short-circuit discipline as the feed block above: the ROUTES entry
// for this path stops at the 401, so on its own it proves only that the route
// is dispatched. These carry a session and a stub that answers the two reads
// the handler makes, so the membership gate and the feed lookup both run.

function draftRecapDb(seen, { member = true, payload } = {}) {
  const make = (sql) => {
    const normalised = sql.replace(/\s+/g, " ").trim();
    const statement = {
      bind: () => statement,
      first: async () => {
        if (normalised.includes("FROM sessions s")) {
          return { id: 1, email: "ada@example.test", name: "Ada", prefs: "{}" };
        }
        if (normalised.includes("FROM fantasy_league_members WHERE league_id")) {
          return member ? { x: 1 } : null;
        }
        if (normalised.includes("FROM fantasy_chat_messages")) {
          return payload === undefined ? null : { payload };
        }
        return null;
      },
      all: async () => ({ results: [] }),
      run: async () => ({ success: true, meta: { changes: 1 } }),
    };
    return statement;
  };
  return {
    prepare: (sql) => {
      seen.push(sql.replace(/\s+/g, " ").trim());
      return make(sql);
    },
    batch: async () => [],
  };
}

function draftRecapCall(options) {
  const seen = [];
  const response = worker.fetch(
    new Request("https://example.test/fantasy/league/1/draft/recap", {
      headers: { Authorization: `Bearer ${SESSION_TOKEN}` },
    }),
    { ...env, DB: draftRecapDb(seen, options) },
  );
  return { response, seen };
}

test("the draft recap route reads the stored recap out of the league feed", async () => {
  const recap = { version: 1, headline: "Bo ran the room", leagueSize: 2, teams: [{ userId: 1, grade: "A" }] };
  const { response, seen } = draftRecapCall({ payload: JSON.stringify({ recap }) });
  const resolved = await response;

  assert.equal(resolved.status, 200);
  // The anti-short-circuit assertion: the feed lookup has to have run, not
  // just the session and membership checks.
  assert.ok(
    seen.some((sql) => sql.includes("FROM fantasy_chat_messages") && sql.includes("event = ?2")),
    "the recap lookup never ran, so this test proves nothing",
  );
  const body = await resolved.json();
  assert.equal(body.recap.headline, "Bo ran the room");
  assert.equal(body.viewerUserId, 1);
});

test("the draft recap route refuses a non-member before reading anything", async () => {
  const { response, seen } = draftRecapCall({ member: false, payload: JSON.stringify({ recap: { headline: "x" } }) });
  assert.equal((await response).status, 403);
  // A private league's grades name every manager in it, so the membership gate
  // must sit in front of the read rather than beside it.
  assert.equal(
    seen.some((sql) => sql.includes("FROM fantasy_chat_messages")),
    false,
    "a non-member's request still read the recap",
  );
});

test("the draft recap route says 404 until the cron has written one", async () => {
  // Distinguishable from "there is nothing here": the client needs to tell
  // "not yet" from an error, and an empty 200 would not.
  assert.equal((await draftRecapCall({}).response).status, 404);
  // A row whose payload cannot be parsed is the same answer, never a 500.
  assert.equal((await draftRecapCall({ payload: "{not json" }).response).status, 404);
  assert.equal((await draftRecapCall({ payload: JSON.stringify({}) }).response).status, 404);
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

// -- Bot managers and the public invite preview, actually executed ------------
//
// Same anti-short-circuit discipline as the feed block above: the ROUTES table
// stops at the 401, so these carry a session and a DB stub that answers the
// specific reads the bot routes make. What is being proved here is the
// authorization pair (commissioner AND pending) and that the seat insert is the
// same guarded INSERT the human join path uses, because the failure mode this
// feature could have introduced is "anyone can add a member to any league".

function botDb(seen, { commissionerUserId = 1, draftStatus = "pending", memberIsBot = true } = {}) {
  const make = (sql) => {
    const normalised = sql.replace(/\s+/g, " ").trim();
    let bound = [];
    const statement = {
      bind: (...args) => {
        bound = args;
        return statement;
      },
      first: async () => {
        if (normalised.includes("FROM sessions s")) {
          return { id: 1, email: "ada@example.test", name: "Ada", prefs: "{}" };
        }
        if (normalised.includes("FROM fantasy_leagues WHERE id")) {
          return { id: 1, name: "Test League", commissioner_user_id: commissionerUserId, draft_status: draftStatus, invite_code: "ABCDEF0123" };
        }
        if (normalised.includes("FROM fantasy_leagues WHERE invite_code")) {
          return { id: 1, name: "Test League", draft_status: draftStatus, commissioner_user_id: commissionerUserId };
        }
        // The remove route's "is this actually a bot in this league" check.
        if (normalised.includes("u.is_bot = 1")) {
          return memberIsBot ? { id: bound[1], name: "Bot Alfie" } : null;
        }
        if (normalised.includes("COUNT(*) AS n")) return { n: 2, bots: 0 };
        return { x: 1 };
      },
      all: async () => {
        if (normalised.includes("FROM fantasy_league_members m JOIN users u")) {
          return {
            results: [
              { user_id: 1, name: "Ada", email: "ada@example.test", is_bot: 0, draft_position: null },
              { user_id: 2, name: "Bot Alfie", email: "x@bots.invalid", is_bot: 1, draft_position: null },
            ],
          };
        }
        return { results: [] };
      },
      run: async () => ({ success: true, meta: { changes: 1, last_row_id: 77 } }),
    };
    return statement;
  };
  return {
    prepare: (sql) => {
      seen.push(sql.replace(/\s+/g, " ").trim());
      return make(sql);
    },
    batch: async () => [],
  };
}

function botCall(path, init = {}, dbOptions) {
  const seen = [];
  const headers = { Authorization: `Bearer ${SESSION_TOKEN}`, ...(init.headers ?? {}) };
  const response = worker.fetch(new Request(`https://example.test${path}`, { ...init, headers }), {
    ...env,
    DB: botDb(seen, dbOptions),
  });
  return { response, seen };
}

const addBots = (count, dbOptions) =>
  botCall(
    "/fantasy/league/1/bots",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ count }) },
    dbOptions,
  );

test("adding bots creates users rows and seats them with the same guarded insert a human join uses", async () => {
  const { response, seen } = addBots(2);
  const resolved = await response;
  assert.equal(resolved.status, 200);

  assert.ok(
    seen.some((sql) => sql.startsWith("INSERT INTO users (google_sub, email, name, is_bot)")),
    "no bot user was ever created, so this test proves nothing",
  );
  // The race guard, and the reason it is not a COUNT-then-INSERT: a real
  // manager joining between the plan and the write must not be pushed out of
  // their own league by a bot.
  assert.ok(
    seen.some(
      (sql) =>
        sql.startsWith("INSERT INTO fantasy_league_members (league_id, user_id) SELECT") &&
        sql.includes("WHERE (SELECT COUNT(*) FROM fantasy_league_members WHERE league_id = ?1) < ?3"),
    ),
    "the seat insert was not guarded on the league size",
  );
  // Orphan sweep, scoped to this league's own bots and to rows with no seat.
  assert.ok(
    seen.some((sql) => sql.startsWith("DELETE FROM users WHERE is_bot = 1 AND google_sub LIKE ?1")),
    "a lost seat race would leave an orphan users row behind",
  );

  const body = await resolved.json();
  assert.equal(body.added.length, 2);
  for (const name of body.added) assert.match(name, /^Bot /);
});

test("only the commissioner can add bots, and only before the draft starts", async () => {
  // The whole security question for this feature: "a commissioner can add a
  // bot" must never become "anyone can add a member to any league".
  const notCommissioner = await addBots(1, { commissionerUserId: 999 }).response;
  assert.equal(notCommissioner.status, 403);

  const alreadyDrafting = await addBots(1, { draftStatus: "drafting" }).response;
  assert.equal(alreadyDrafting.status, 400);

  const { seen } = addBots(1, { commissionerUserId: 999 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(
    !seen.some((sql) => sql.startsWith("INSERT INTO users")),
    "a non-commissioner reached the insert",
  );
});

test("adding bots refuses a count that is not a sane integer", async () => {
  // "3" is deliberately absent: Number("3") is a perfectly good 3, and
  // rejecting a JSON string of digits would be pedantry rather than safety.
  for (const count of [0, -1, 1.5, 999, "three", null]) {
    const response = await addBots(count).response;
    assert.equal(response.status, 400, `count ${String(count)} was accepted`);
  }
});

test("removing a bot refuses a target that is not a bot in that league", async () => {
  const ok = await botCall("/fantasy/league/1/bots/2", { method: "DELETE" }).response;
  assert.equal(ok.status, 200);

  // The check that stops this becoming "the commissioner can evict a manager".
  const human = await botCall("/fantasy/league/1/bots/2", { method: "DELETE" }, { memberIsBot: false }).response;
  assert.equal(human.status, 404);

  const stranger = await botCall("/fantasy/league/1/bots/2", { method: "DELETE" }, { commissionerUserId: 999 })
    .response;
  assert.equal(stranger.status, 403);
});

test("the invite preview is readable with no session and leaks no ids or emails", async () => {
  // The only unauthenticated fantasy route, and deliberately so: a shared link
  // has to show what is being joined BEFORE asking for a sign-in.
  const seen = [];
  const response = await worker.fetch(new Request("https://example.test/fantasy/invite/ABCDEF0123"), {
    ...env,
    DB: botDb(seen),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");

  const body = await response.json();
  assert.equal(body.league.name, "Test League");
  assert.equal(body.league.joinable, true);
  assert.equal(body.league.seats.humans, 1);
  assert.equal(body.league.seats.bots, 1);
  // A bot in the preview is labelled, because somebody deciding whether to join
  // must be able to see how much of the room is real.
  assert.deepEqual(
    body.managers.map((m) => m.isBot),
    [false, true],
  );

  const serialised = JSON.stringify(body);
  assert.ok(!serialised.includes("@example.test"), "an email address reached the public preview");
  assert.ok(!serialised.includes("ABCDEF0123"), "the invite code was echoed back");
  assert.ok(!serialised.includes("userId"), "a user id reached the public preview");
});

test("an unknown invite code is a 404, not an error", async () => {
  const response = await worker.fetch(new Request("https://example.test/fantasy/invite/ZZZZZZZZZZ"), {
    ...env,
    DB: stubDb(), // every read answers null: no league carries that code
  });
  assert.equal(response.status, 404);
});

// -- A bot account cannot be signed in as -------------------------------------
//
// THE security-critical property of bot managers. A bot is a users row, and
// handleGoogleAuth upserts on google_sub, so a sub that matched one would issue
// a real bearer session for a bot and hand over its league membership. Google
// cannot produce such a sub, which is exactly why that namespace was chosen,
// but the gate is asserted here rather than assumed.

function authDb(seen) {
  const statement = {
    bind: () => statement,
    first: async () => ({ id: 1, email: "ada@example.test", name: "Ada", prefs: "{}" }),
    all: async () => ({ results: [] }),
    run: async () => ({ success: true, meta: { changes: 1, last_row_id: 1 } }),
  };
  return {
    prepare: (sql) => {
      seen.push(sql.replace(/\s+/g, " ").trim());
      return statement;
    },
    batch: async () => [],
  };
}

function stubTokeninfo(sub) {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        aud: "test-client-id",
        iss: "https://accounts.google.com",
        sub,
        email: "someone@example.test",
        email_verified: "true",
        name: "Someone",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  return () => {
    globalThis.fetch = original;
  };
}

async function signInWithSub(sub) {
  const seen = [];
  const restore = stubTokeninfo(sub);
  try {
    const response = await worker.fetch(
      new Request("https://example.test/auth/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: "x".repeat(64) }),
      }),
      { ...env, GOOGLE_CLIENT_ID: "test-client-id", DB: authDb(seen) },
    );
    return { response, seen };
  } finally {
    restore();
  }
}

test("a bot account cannot be signed in as", async () => {
  const { response, seen } = await signInWithSub("bot:1:deadbeef");
  assert.equal(response.status, 401);
  // Not just the status: nothing may have touched the users table or minted a
  // session, or a later refactor could return 401 after already writing.
  assert.ok(!seen.some((sql) => sql.startsWith("INSERT INTO users")), "the bot's users row was upserted");
  assert.ok(!seen.some((sql) => sql.startsWith("INSERT INTO sessions")), "a session was minted for a bot");
  const body = await response.json();
  assert.ok(!body.token, "a bearer token was handed out");
});

test("the same gate rejects any subject outside Google's own digit namespace", async () => {
  for (const sub of ["bot:99:aa", "admin", "1;DROP", " 42", "42 ", "4e2"]) {
    const { response } = await signInWithSub(sub);
    assert.equal(response.status, 401, `sub ${sub} was accepted`);
  }
  // And a real Google subject still gets through, so the gate is not simply
  // refusing everything.
  const { response, seen } = await signInWithSub("104283910938501928374");
  assert.equal(response.status, 200);
  assert.ok(seen.some((sql) => sql.startsWith("INSERT INTO users")));
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
  // The squad deadline travels with the lineup so the pitch can count down to
  // it. Null here (no feed behind this stub), but the KEY must be present or
  // the client has no way to tell "no deadline known" from "not sent".
  assert.ok(Object.hasOwn(body, "deadline"));
  assert.equal(body.locked, false, "no feed must fail open, never lock a manager out");
});

// -- The league's own season schedule, actually executed ----------------------
//
// The stub has to return real fixtures and real members, because the whole
// point of the route is a derivation over both: a BYE is the absence of a row,
// so a stub that returns no fixtures would let a broken bye derivation pass.
// Three members and one fixture per gameweek is exactly production League 1's
// shape (Mark v Rory, Eoin byes), which is the case this was written for.
const SCHEDULE_MEMBERS = [
  { user_id: 1, name: "Ada", email: "ada@example.test", is_bot: 0 },
  { user_id: 2, name: "Rory", email: "rory@example.test", is_bot: 0 },
  { user_id: 3, name: "Eoin", email: "eoin@example.test", is_bot: 0 },
];

function scheduleDb(seen) {
  const makeStatement = (sql) => {
    const normalised = sql.replace(/\s+/g, " ").trim();
    const statement = {
      bind: () => statement,
      first: async () => {
        if (normalised.includes("FROM sessions s")) return { id: 1, email: "ada@example.test", name: "Ada", prefs: "{}" };
        return { x: 1 };
      },
      all: async () => {
        if (normalised.includes("FROM fantasy_h2h_fixtures")) {
          return {
            results: [
              { gameweek: 1, home_user_id: 1, away_user_id: 2, home_score: null, away_score: null },
              { gameweek: 2, home_user_id: 2, away_user_id: 3, home_score: null, away_score: null },
              { gameweek: 3, home_user_id: 3, away_user_id: 1, home_score: 61.5, away_score: 48 },
            ],
          };
        }
        if (normalised.includes("FROM fantasy_league_members m")) return { results: SCHEDULE_MEMBERS };
        return { results: [] };
      },
      run: async () => ({ success: true, meta: { changes: 1 } }),
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

function scheduleCall(path) {
  const seen = [];
  const headers = { Authorization: `Bearer ${SESSION_TOKEN}` };
  const response = worker.fetch(new Request(`https://example.test${path}`, { headers }), {
    ...env,
    DB: scheduleDb(seen),
  });
  return { response, seen };
}

test("GET the league schedule returns every gameweek, not just the current one", async () => {
  const { response, seen } = scheduleCall("/fantasy/league/1/schedule");
  const resolved = await response;
  assert.equal(resolved.status, 200);
  assert.ok(
    seen.some((sql) => sql.includes("FROM fantasy_h2h_fixtures")),
    "the fixtures read never ran, so this test proves nothing",
  );

  const body = await resolved.json();
  assert.equal(body.gameweeks.length, 3);
  assert.deepEqual(
    body.gameweeks.map((week) => week.gameweek),
    [1, 2, 3],
    "gameweeks must come back in season order",
  );
  assert.equal(body.gameweeks[0].fixtures.length, 1);
  assert.deepEqual(body.gameweeks[0].fixtures[0], {
    homeUserId: 1,
    awayUserId: 2,
    homeScore: null,
    awayScore: null,
  });
});

test("the schedule states a bye plainly instead of leaving a manager with no row", async () => {
  // The complaint this route exists for: an odd-sized league byes somebody
  // every week, and that manager currently sees nothing at all, which is
  // indistinguishable from a bug.
  const { response } = scheduleCall("/fantasy/league/1/schedule");
  const body = await (await response).json();

  assert.deepEqual(body.gameweeks[0].byeUserIds, [3], "Eoin byes gameweek 1");
  assert.deepEqual(body.gameweeks[1].byeUserIds, [1], "Ada byes gameweek 2");
  assert.deepEqual(body.gameweeks[2].byeUserIds, [2], "Rory byes gameweek 3");
  // Exactly one manager byes each week in a three-manager league, never zero
  // and never all of them.
  for (const week of body.gameweeks) assert.equal(week.byeUserIds.length, 1);
});

test("the schedule carries member names so a bye can be attributed to a person", async () => {
  const { response } = scheduleCall("/fantasy/league/1/schedule");
  const body = await (await response).json();
  assert.equal(body.members.length, 3);
  assert.deepEqual(
    body.members.map((member) => member.name).sort(),
    ["Ada", "Eoin", "Rory"],
  );
  // A settled gameweek keeps its real scores; an unplayed one stays null so
  // the client can render it as upcoming rather than as a 0-0 result.
  assert.equal(body.gameweeks[0].fixtures[0].homeScore, null);
  assert.equal(body.gameweeks[2].fixtures[0].homeScore, 61.5);
});

test("the schedule route is membership-checked like every other league route", async () => {
  const response = await worker.fetch(new Request("https://example.test/fantasy/league/1/schedule"), env);
  assert.equal(response.status, 401, "an unauthenticated caller must not read a league's schedule");
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

// -- API-Football quota analytics, end to end ---------------------------------
//
// Same anti-short-circuit discipline as the blocks above, and it needs more
// than a route entry: /health/quota returns 501 on its first line without a DB
// binding, so the ROUTES table alone would prove nothing about whether a single
// upstream call is ever counted.
//
// So this block stubs the upstream instead of the database, drives real
// requests through the Worker's own fetchJson, and then reads the analytics
// route back through a D1 stub that actually stores what the flush writes. That
// is the only way to prove the whole chain: response headers -> buffer ->
// flushed counts -> the rollup a dashboard reads.
// A D1 stub that really stores the two analytics tables, because the assertion
// worth making is about the numbers that come back out, not about SQL strings.
function usageDb(seen = []) {
  const daily = new Map();
  let quota = null;
  const make = (sql) => {
    const normalised = sql.replace(/\s+/g, " ").trim();
    const statement = {
      sql: normalised,
      bound: [],
      bind: (...args) => {
        statement.bound = args;
        return statement;
      },
      first: async () => (normalised.startsWith("SELECT daily_limit") ? quota : null),
      all: async () => {
        if (!normalised.startsWith("SELECT endpoint")) return { results: [] };
        return { results: [...daily.values()] };
      },
      run: async () => ({ success: true }),
    };
    return statement;
  };
  const apply = (statement) => {
    const [a, b, c, d] = statement.bound;
    if (statement.sql.startsWith("INSERT INTO api_usage_daily")) {
      const key = `${a}|${b}|${c}`;
      const row = daily.get(key) ?? { endpoint: b, upstream: c, calls: 0 };
      row.calls += d;
      daily.set(key, row);
    } else if (statement.sql.startsWith("INSERT INTO api_usage_quota")) {
      quota = { daily_limit: b, daily_remaining: Math.min(quota?.daily_remaining ?? c, c) };
    }
  };
  return {
    prepare: (sql) => {
      const statement = make(sql);
      seen.push(statement.sql);
      return statement;
    },
    batch: async (statements) => {
      for (const statement of statements) apply(statement);
      return [];
    },
  };
}

// waitUntil work is collected so a test can await the flush rather than race it.
function usageCall(path, db, pending) {
  return worker.fetch(new Request(`https://example.test${path}`), { ...env, DB: db }, {
    waitUntil: (promise) => pending.push(promise),
  });
}

test("the analytics route degrades to 501 rather than erroring when D1 is absent", async () => {
  const { DB, ...noDb } = env;
  const response = await worker.fetch(new Request("https://example.test/health/quota"), noDb);
  assert.equal(response.status, 501);
});

test("upstream calls are counted at the chokepoint and read back as a rollup", async () => {
  const restore = stubUpstream();
  try {
    // Whatever earlier tests in this file left in the isolate's buffer is
    // flushed into a throwaway database first, so the counts asserted below
    // belong to this test and not to the route smoke tests above.
    await usageCall("/health/quota", usageDb(), []);

    const pending = [];
    const detail = await usageCall(`/match/${FIXTURE_IDS.usage}`, usageDb(), pending);
    assert.equal(detail.status, 200);

    const seen = [];
    const db = usageDb(seen);
    const report = await (await usageCall("/health/quota", db, pending)).json();
    await Promise.all(pending);

    assert.ok(
      seen.some((sql) => sql.startsWith("INSERT INTO api_usage_daily")),
      "nothing was ever flushed, so this test proves nothing",
    );
    assert.ok(
      seen.some((sql) => sql.startsWith("SELECT endpoint, upstream, calls FROM api_usage_daily")),
      "the rollup read never ran",
    );

    // The four detail payloads plus the live feed the id validation needs all
    // went through fetchJson, so every one of them has to appear as spend.
    const spent = report.endpoints.filter((entry) => entry.upstream > 0).map((entry) => entry.endpoint);
    for (const endpoint of ["/fixtures", "/fixtures/lineups", "/fixtures/events", "/fixtures/players"]) {
      assert.ok(spent.includes(endpoint), `${endpoint} was not counted as spend`);
    }
    assert.ok(report.upstreamCalls > 0);
    assert.equal(report.quota.dailyLimit, 150000);
    // The provider's own figure wins over our count: the same key is spent by
    // the Pages bake too.
    assert.equal(report.quota.usedSource, "provider");
    assert.equal(report.quota.used, 1000);
    assert.ok(["ok", "tight", "over", "unknown"].includes(report.projection.verdict));
  } finally {
    restore();
  }
});

test("a cache-served response is counted, but never as spend", async () => {
  // The whole reason src/apiQuota.js exists: cacheEverything means a cached
  // response REPLAYS the stored rate-limit headers, so believing them would
  // both overstate usage and make the remaining gauge jump backwards.
  const restore = stubUpstream({
    [`/fixtures/events?fixture=${FIXTURE_IDS.cacheHit}`]: () => apiResponse(emptyPayload, { cacheStatus: "HIT", remaining: 900 }),
  });
  try {
    // One store for all three calls, not a throwaway each. A flush already in
    // flight when the report is requested is shared rather than restarted (see
    // flushApiUsage), so with separate stores the drawer's records could land
    // in a database the report never reads.
    const db = usageDb();
    await usageCall("/health/quota", db, []);
    const pending = [];
    await usageCall(`/match/${FIXTURE_IDS.cacheHit}`, db, pending);
    const report = await (await usageCall("/health/quota", db, pending)).json();
    await Promise.all(pending);

    const events = report.endpoints.find((entry) => entry.endpoint === "/fixtures/events");
    assert.ok(events.cached > 0, "the cache hit was not counted at all");
    assert.equal(events.upstream, 0, "a cache hit must never be charged to the allowance");
    assert.ok(report.cacheHitRate > 0 && report.cacheHitRate < 1);
    assert.notEqual(report.quota.dailyRemaining, 900, "a replayed remaining header was believed");
  } finally {
    restore();
  }
});

// -- /match/:id on a fixture that has not been played -------------------------

test("an unplayed fixture returns its pre-match detail instead of a 502", async () => {
  const restore = stubUpstream();
  try {
    const response = await usageCall(`/match/${FIXTURE_IDS.unplayed}`, usageDb(), []);
    assert.equal(response.status, 200);
    const detail = await response.json();
    assert.equal(detail.home.name, "Arsenal");
    assert.equal(detail.away.name, "Coventry City");
    assert.equal(detail.venue, "Emirates Stadium");
    assert.deepEqual(detail.goals, []);
    assert.deepEqual(detail.home.lineup, []);
    // A healthy read keeps exactly the shape the baked static match files
    // carry, so the drawer cannot tell the two sources apart.
    assert.equal(detail.degraded, undefined);
  } finally {
    restore();
  }
});

test("one failing supplementary payload no longer throws away the three that worked", async () => {
  // This is the actual defect behind the reported 502: any single upstream
  // hiccup on lineups, events or player stats discarded the fixture payload
  // that had already arrived.
  const restore = stubUpstream({
    [`/fixtures/players?fixture=${FIXTURE_IDS.supplementary}`]: () => new Response("upstream is having a moment", { status: 500 }),
  });
  try {
    const response = await usageCall(`/match/${FIXTURE_IDS.supplementary}`, usageDb(), []);
    assert.equal(response.status, 200);
    const detail = await response.json();
    assert.equal(detail.home.name, "Arsenal");
    assert.deepEqual(detail.playerStats, []);
    // Named, not a bare flag: not knowing WHICH of the four was failing is what
    // made this hard to diagnose from the outside.
    assert.deepEqual(detail.degraded, ["/fixtures/players"]);
    // And cached briefly, so the blip cannot outlive itself in every reader's
    // browser.
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=30");
  } finally {
    restore();
  }
});

test("a failure on the fixture payload itself is still an honest 502", async () => {
  // Fail-soft must not become fail-silent. Without the fixture payload there
  // are no teams, no kickoff and no venue, so there is no match to describe and
  // a real upstream outage must still read as one.
  const restore = stubUpstream({
    [`/fixtures?id=${FIXTURE_IDS.fixtureFailure}`]: () => new Response("down", { status: 500 }),
  });
  try {
    const response = await usageCall(`/match/${FIXTURE_IDS.fixtureFailure}`, usageDb(), []);
    assert.equal(response.status, 502);
  } finally {
    restore();
  }
});

test("the per-IP detail limiter answers 429 once its window is spent", async () => {
  // The binding itself is Cloudflare's; what is testable here is that the
  // route consults it before doing any upstream work and turns a refusal into
  // a 429 with a Retry-After rather than falling through to the fetch.
  const restore = stubUpstream();
  let calls = 0;
  const DETAIL_LIMITER = { limit: async () => ({ success: ++calls <= 20 }) };
  try {
    const statuses = [];
    for (let i = 0; i < 22; i += 1) {
      const response = await worker.fetch(
        new Request(`https://example.test/match/${FIXTURE_IDS.limiter}`),
        { ...env, DB: usageDb(), DETAIL_LIMITER },
        { waitUntil: () => {} },
      );
      statuses.push(response.status);
    }
    assert.equal(statuses.filter((status) => status === 429).length, 2);
    assert.equal(statuses[19], 200);
    assert.equal(statuses[20], 429);
  } finally {
    restore();
  }
});

// -- The API-Football budget guard rail, end to end ---------------------------
//
// DELIBERATELY LAST IN THE FILE, and it must stay last. The guard rail reads
// the provider's own remaining count out of a sticky, isolate-lifetime gauge
// (latestQuota in src/apiQuotaStore.js) that only ever ratchets DOWN within a
// UTC day, because within a day the provider's counter only falls. That is the
// behaviour production needs and it means a test which teaches this process
// that the allowance is nearly gone cannot un-teach it. So these run after
// everything that assumes a healthy budget.
//
// A route-list entry would prove nothing here: /match/:id answers 200 at every
// budget level by design. What has to be proved is the COST, so these count
// upstream calls rather than statuses.

function countingUpstream(remaining) {
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input?.url ?? input);
    if (!url.startsWith(UPSTREAM)) {
      return new Response(JSON.stringify({ players: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const path = url.replace(UPSTREAM, "");
    calls.push(path);
    const response = respondFor(path);
    const headers = new Headers(response.headers);
    headers.set("x-ratelimit-requests-limit", "7500");
    headers.set("x-ratelimit-requests-remaining", String(remaining));
    return new Response(response.body, { status: response.status, headers });
  };
  return calls;
}

test("with the allowance nearly gone the drawer sheds payloads but still answers", async () => {
  // 300 of 7500 is 4%, inside the critical band. The drawer must then cost
  // ZERO upstream calls of its own and still describe a real match, built from
  // the fixture summary the id validation already returned.
  const calls = countingUpstream(300);
  try {
    // The gauge is only ever taught by a response that actually came back from
    // upstream, and the memo means a repeat URL never does. So prime it with a
    // drawer on its OWN fixture id: those four reads are fresh, they carry the
    // low remaining header, and they leave the guard rail armed for the read
    // that is actually being measured below.
    await usageCall(`/match/${FIXTURE_IDS.budgetConserve}`, usageDb(), []);
    const before = calls.length;

    const response = await usageCall(`/match/${FIXTURE_IDS.budgetCritical}`, usageDb(), []);
    assert.equal(response.status, 200, "the guard rail turned a degradation into an error");
    const detail = await response.json();

    assert.equal(calls.length - before, 0, "the drawer still spent upstream calls at the critical level");
    // Still a real answer, not an empty husk.
    assert.equal(detail.home.name, "Arsenal");
    assert.equal(detail.away.name, "Coventry City");
    assert.equal(detail.venue, "Emirates Stadium");
    // And it says which parts are missing, in the same vocabulary a genuine
    // upstream failure uses, so the drawer needs no second code path.
    assert.deepEqual(detail.degraded, ["/fixtures/lineups", "/fixtures/events", "/fixtures/players"]);
  } finally {
    installUpstream();
  }
});

test("the analysis pass stands down before anything a season depends on", async () => {
  // Same critical budget. The cron must still run its fantasy passes (they are
  // what settle a gameweek) while the AI analysis pass, the most expensive and
  // least load-bearing, does not fetch match detail at all.
  const calls = countingUpstream(300);
  const seen = [];
  try {
    const pending = [];
    await worker.scheduled(
      { cron: "* * * * *" },
      { ...env, FANTASY_GAMEWEEK_OVERRIDE: "12", DB: cronDb(seen, []), ANALYSIS_CACHE: { get: async () => null, put: async () => {} }, ANTHROPIC_API_KEY: "x" },
      { waitUntil: (promise) => pending.push(promise) },
    );
    await Promise.all(pending);

    assert.equal(
      calls.filter((path) => path.startsWith("/fixtures/")).length,
      0,
      "the analysis pass was still fetching per-match detail on a critical budget",
    );
    // The fantasy passes are never shed: the waiver run still reached D1.
    assert.ok(
      seen.some((sql) => sql.startsWith("INSERT INTO fantasy_waiver_locks")),
      "a low budget wrongly stopped the waiver run, which is the opposite of the priority order",
    );
  } finally {
    installUpstream();
  }
});
