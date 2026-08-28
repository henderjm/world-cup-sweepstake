import assert from "node:assert/strict";
import test from "node:test";

import worker from "../worker/worker.js";

// The soft throttle's OTHER face, end to end through the real Worker.
//
// test/live-ingest.test.js pins the rescue path for a REFUSED status batch
// (429). This file pins the same rescue for the failure shape that used to
// sail straight past it: api-sports answering the batched /fixtures?ids=
// request with a clean 200 and `response: []` for fixtures that HAVE data
// (measured GW1 2026-27, the same key answering a residential IP in full in
// the same second). Before getLive judged the kicked-off batch by what it
// ANSWERED, that shape merged nothing, threw nothing, and the season
// schedule's "not kicked off" went out as a fresh 200 about a match in its
// second half -- no "delayed" chip, and a 200 that suppressed the browser's
// static-bake fallback too. That is the "match started, no live updates"
// report.
//
// Own file rather than more cases in live-ingest.test.js: the empty payload
// is memoised per URL for up to a minute (unlike a thrown 429, which is never
// memoised), and worker.js's module state (memo, lastLive) is shared within a
// test process, so these scenarios need a process of their own.

const UPSTREAM = "https://v3.football.api-sports.io";
const LIVE_ID = 910001; // PL, rescued by the pushed copy
const DARK_ID = 910002; // CL, nothing pushed anywhere

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

// Kicked off half an hour ago: in fixturePollingPlan's `active` bucket, so the
// batched status read is the only thing that can say it is in play.
const kickoff = () => new Date(Date.now() - 30 * 60 * 1000).toISOString();

const fixture = (id) => ({
  fixture: { id, date: kickoff(), status: { short: "NS", elapsed: null }, venue: { name: "Emirates Stadium", city: "London" } },
  league: { round: "Regular Season - 3" },
  teams: { home: { id: 42, name: "Arsenal", logo: "h.png" }, away: { id: 1076, name: "Coventry City", logo: "a.png" } },
  goals: { home: null, away: null },
  score: { halftime: { home: null, away: null }, penalty: { home: null, away: null } },
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

// The schedule answers in full; the status batch answers a clean 200 with
// nothing in it, exactly as the soft throttle does for a kicked-off fixture.
globalThis.fetch = async (input) => {
  const url = String(input?.url ?? input);
  if (!url.startsWith(UPSTREAM)) return ok({ players: [] });
  const path = url.replace(UPSTREAM, "");
  if (path.startsWith("/fixtures?ids=")) return ok(payload([]));
  if (path.startsWith("/standings")) return ok({ errors: [], response: [] });
  if (path.startsWith("/fixtures?league=39")) return ok(payload([fixture(LIVE_ID)]));
  if (path.startsWith("/fixtures?league=2")) return ok(payload([fixture(DARK_ID)]));
  if (path.startsWith("/fixtures")) return ok(payload([]));
  throw new Error(`unstubbed upstream ${path}`);
};

const call = (path, init = {}) => worker.fetch(new Request(`https://example.test${path}`, init), env);

test("an empty status batch serves the pushed live score instead of calling the match pre-match", async () => {
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
          minute: 34,
          score: { home: 1, away: 0 },
          homeTeam: "Arsenal",
          awayTeam: "Coventry City",
        },
      ],
    }),
  );

  const response = await call("/PL/live");
  assert.equal(response.status, 200, "an empty batch with a pushed copy must not reach the 502-to-bake path");
  const body = await response.json();
  const match = body.matches.find((entry) => entry.id === LIVE_ID);
  assert.equal(match.status, "IN_PLAY", "the score is live, not the schedule's pre-match status");
  assert.deepEqual(match.score, { home: 1, away: 0 });
  assert.equal(match.minute, 34);

  // Same honesty rules as the refusal path: the body is marked, and it dates
  // itself by the push rather than by the moment it was assembled, because the
  // "delayed" chip reads body.stale and never lastUpdated.
  assert.equal(body.stale, true);
  assert.equal(body.ingestedLive, true, "the marker that earns the wider grace in src/liveStale.js");
  assert.ok(body.staleAgeMs > 0);
  const claimed = Date.parse(body.lastUpdated);
  assert.ok(Math.abs(claimed - pushedAt) < 5000, `lastUpdated ${body.lastUpdated} should date the push, not now`);
});

test("an empty status batch with nothing pushed still refuses to state 'not kicked off' as fact", async () => {
  // The guard that matters most, and the one the clean 200 used to slip: a
  // fresh-looking 200 carrying the schedule's NS about a match half an hour
  // old would suppress the static-bake fallback written for exactly this case.
  const response = await call("/CL/live");
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error, "upstream unavailable");
});
