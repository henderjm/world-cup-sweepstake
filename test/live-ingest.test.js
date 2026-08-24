import assert from "node:assert/strict";
import test from "node:test";

import worker from "../worker/worker.js";

// The live scoreboard's rescue path, end to end through the real Worker.
//
// Everything that MOVES during a match - score, minute, status - reaches the
// Worker through one path only: fetchJson against api-sports from Cloudflare's
// shared egress, the egress api-sports refuses and soft-throttles. The match
// drawer already had a way out (the feeder pushes detail in from GitHub's
// egress, a refused read swaps in the KV snapshot); the scoreboard had none, so
// a refused status batch froze the score until the browser was 502'd to the
// hourly static bake, up to an hour behind, while the drawer for the SAME match
// was current. These tests pin the way out and, just as importantly, pin the
// thing that must NOT happen: a refusal must never be dressed up as a confident
// "not kicked off".
//
// ORDERING MATTERS. fetchJson memoises successful payloads per URL for the ttl
// the call site declared (src/apiCache.js) and errors are never memoised, so a
// test that lets the status batch succeed would leave a memo every later test
// would hit. Every test here therefore keeps the batch broken, and the two
// competitions are used to keep one scenario's lastLive out of the other's.

const UPSTREAM = "https://v3.football.api-sports.io";
const LIVE_ID = 900001; // PL, overlaid from the pushed copy
const DARK_ID = 900002; // CL, nothing pushed anywhere

function stubKv() {
  const store = new Map();
  return {
    store,
    get: async (key) => store.get(key) ?? null,
    put: async (key, value) => void store.set(key, value),
    delete: async (key) => void store.delete(key),
  };
}

const kv = stubKv();
const env = {
  API_FOOTBALL_KEY: "test-key",
  API_FOOTBALL_COMPETITIONS: "PL:2026,CL:2026",
  DETAIL_INGEST_TOKEN: "feeder-secret",
  ANALYSIS_CACHE: kv,
};

// Kicked off half an hour ago. That is what puts it in fixturePollingPlan's
// `active` bucket, which is the batch this suite refuses.
const kickoff = () => new Date(Date.now() - 30 * 60 * 1000).toISOString();

const fixture = (id, { status = "NS", elapsed = null, home = null, away = null } = {}) => ({
  fixture: { id, date: kickoff(), status: { short: status, elapsed }, venue: { name: "Emirates Stadium", city: "London" } },
  league: { round: "Regular Season - 3" },
  teams: { home: { id: 42, name: "Arsenal", logo: "h.png" }, away: { id: 1076, name: "Coventry City", logo: "a.png" } },
  goals: { home, away },
  score: { halftime: { home, away }, penalty: { home: null, away: null } },
});

const payload = (response) => ({ errors: [], results: response.length, paging: { current: 1, total: 1 }, response });

const ok = (body) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cf-cache-status": "MISS",
      "x-ratelimit-requests-limit": "150000",
      "x-ratelimit-requests-remaining": "149000",
    },
  });

// The schedule answers; the status batch - the only call that carries a live
// score - is refused exactly as api-sports refuses the Workers egress.
globalThis.fetch = async (input) => {
  const url = String(input?.url ?? input);
  if (!url.startsWith(UPSTREAM)) return ok({ players: [] });
  const path = url.replace(UPSTREAM, "");
  if (path.startsWith("/fixtures?ids=")) return new Response("rate limited", { status: 429 });
  if (path.startsWith("/standings")) return ok({ errors: [], response: [] });
  if (path.startsWith("/fixtures?league=39")) return ok(payload([fixture(LIVE_ID)]));
  if (path.startsWith("/fixtures?league=2")) return ok(payload([fixture(DARK_ID)]));
  if (path.startsWith("/fixtures")) return ok(payload([]));
  throw new Error(`unstubbed upstream ${path}`);
};

const call = (path, init = {}) => worker.fetch(new Request(`https://example.test${path}`, init), env);

const push = (comp, body, token = "feeder-secret") =>
  call(`/ingest/live/${comp}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

// -- the ingest route ---------------------------------------------------------

test("the live ingest refuses a caller without the feeder's bearer token", async () => {
  const response = await push("PL", { fixtures: payload([fixture(LIVE_ID)]) }, "wrong");
  assert.equal(response.status, 401);
  assert.equal(kv.store.size, 0, "an unauthorized push must store nothing");
});

test("the live ingest refuses a competition the Worker is not configured for", async () => {
  // Otherwise a pushed code mints an arbitrary KV key.
  const response = await push("ZZ", { fixtures: payload([fixture(LIVE_ID)]) });
  assert.equal(response.status, 404);
  assert.equal(kv.store.size, 0);
});

test("an empty push is refused rather than stored over a good copy", async () => {
  // A day with no fixtures and a soft-throttled read are indistinguishable from
  // here, and storing [] could only ever mask a good copy.
  const response = await push("PL", { fixtures: payload([]) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { stored: false, reason: "no fixtures" });
  assert.equal(kv.store.size, 0);
});

test("a pushed fixtures payload is mapped and stored under the competition", async () => {
  const response = await push("PL", {
    fixtures: payload([fixture(LIVE_ID, { status: "2H", elapsed: 67, home: 2, away: 1 })]),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { stored: true, matches: 1 });

  const stored = JSON.parse(kv.store.get("live:last:PL"));
  assert.equal(stored.matches.length, 1);
  assert.equal(stored.matches[0].id, LIVE_ID);
  assert.equal(stored.matches[0].status, "IN_PLAY", "mapped through the shared ingestion contract");
  assert.deepEqual(stored.matches[0].score, { home: 2, away: 1 });
});

// -- the overlay --------------------------------------------------------------

test("a refused status batch serves the pushed live score instead of freezing", async () => {
  const response = await call("/PL/live");
  assert.equal(response.status, 200, "a refusal with a pushed copy must not reach the 502-to-bake path");
  const body = await response.json();
  const match = body.matches.find((entry) => entry.id === LIVE_ID);
  assert.equal(match.status, "IN_PLAY", "the score is live, not the schedule's pre-match status");
  assert.deepEqual(match.score, { home: 2, away: 1 });
  assert.equal(match.minute, 67);
});

test("an overlaid body dates itself by the pushed copy, never by the moment it was assembled", async () => {
  // The scoreline is as old as the push. Stamping "just now" over it is the
  // dishonesty the whole staleness apparatus in this Worker exists to prevent.
  const pushedAt = Date.now() - 90 * 1000;
  kv.store.set(
    "live:last:PL",
    JSON.stringify({
      storedAt: pushedAt,
      matches: [
        {
          id: LIVE_ID,
          utcDate: kickoff(),
          status: "IN_PLAY",
          minute: 70,
          score: { home: 3, away: 1 },
          homeTeam: "Arsenal",
          awayTeam: "Coventry City",
        },
      ],
    }),
  );
  const body = await (await call("/PL/live")).json();
  assert.deepEqual(body.matches.find((entry) => entry.id === LIVE_ID).score, { home: 3, away: 1 });
  const claimed = Date.parse(body.lastUpdated);
  assert.ok(Math.abs(claimed - pushedAt) < 5000, `lastUpdated ${body.lastUpdated} should date the push, not now`);
});

test("an overlaid body announces itself as delayed, because the chip reads the flag not the date", async () => {
  // recordFeedFreshness in src/app.js derives the "(delayed)" chip from
  // body.stale and never from lastUpdated, so an unannounced overlay would read
  // "updated just now" over a scoreline several minutes old.
  const body = await (await call("/PL/live")).json();
  assert.equal(body.stale, true);
  assert.equal(body.ingestedLive, true, "the marker that earns the wider grace in src/liveStale.js");
  assert.ok(body.staleAgeMs > 0);
});

test("a pushed copy past its own grace hands the browser to the static bake", async () => {
  const original = kv.store.get("live:last:PL");
  kv.store.set(
    "live:last:PL",
    JSON.stringify({
      storedAt: Date.now() - 50 * 60 * 1000, // past INGESTED_LIVE_GRACE_MS
      matches: [{ id: LIVE_ID, utcDate: kickoff(), status: "IN_PLAY", minute: 70, score: { home: 3, away: 1 } }],
    }),
  );
  const response = await call("/PL/live");
  assert.equal(response.status, 502, "an hour-old push is no better than the bake it competes with");
  kv.store.set("live:last:PL", original);
});

test("a refusal with nothing pushed still refuses to call a kicked-off match pre-match", async () => {
  // The guard that matters most. Serving the season schedule as a fresh 200
  // would state "not kicked off" as fact about a match half an hour old, and
  // would suppress the static-bake fallback written for exactly this case.
  const response = await call("/CL/live");
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error, "upstream unavailable");
  assert.equal(kv.store.has("live:last:CL"), false);
});
