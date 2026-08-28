import assert from "node:assert/strict";
import test from "node:test";

import worker from "../worker/worker.js";

// A failed PRE-MATCH status batch must not fail the whole live read.
//
// Before getLive scoped failure to the kicked-off batch, any batch throwing
// marked the read failed, so a throttled pre-match refresh on an afternoon
// with nothing in play sent the browser to stale-or-502 -- and on a mixed
// afternoon it let an older pushed copy overwrite kicked-off scores that had
// just arrived. Nothing in a pre-match batch has kicked off, so the season
// schedule already states its truth and a fresh 200 is the honest answer.
//
// Own file for the same reason as live-empty-batch.test.js: worker.js's
// module state (the response memo, lastLive) is shared within a process, and
// this scenario needs a schedule whose fixture has NOT kicked off.

const UPSTREAM = "https://v3.football.api-sports.io";
const UPCOMING_ID = 920001;

const env = {
  API_FOOTBALL_KEY: "test-key",
  API_FOOTBALL_COMPETITIONS: "PL:2026",
};

// An hour from now: inside fixturePollingPlan's two-hour pre-match window, so
// the plan issues an `upcoming` batch and nothing else.
const kickoff = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

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

globalThis.fetch = async (input) => {
  const url = String(input?.url ?? input);
  if (!url.startsWith(UPSTREAM)) return ok({ players: [] });
  const path = url.replace(UPSTREAM, "");
  if (path.startsWith("/fixtures?ids=")) return new Response("rate limited", { status: 429 });
  if (path.startsWith("/standings")) return ok({ errors: [], response: [] });
  if (path.startsWith("/fixtures?league=39")) return ok(payload([fixture(UPCOMING_ID)]));
  if (path.startsWith("/fixtures")) return ok(payload([]));
  throw new Error(`unstubbed upstream ${path}`);
};

const call = (path) => worker.fetch(new Request(`https://example.test${path}`), env);

test("a refused pre-match batch serves the schedule as a fresh 200, not a stale-or-502", async () => {
  const response = await call("/PL/live");
  assert.equal(response.status, 200);
  const body = await response.json();
  const match = body.matches.find((entry) => entry.id === UPCOMING_ID);
  assert.equal(match.status, "TIMED", "the schedule's truth IS current for a fixture that has not kicked off");
  assert.equal(body.stale, undefined, "nothing live is missing, so the body is not delayed");
  const claimed = Date.parse(body.lastUpdated);
  assert.ok(Math.abs(claimed - Date.now()) < 5000, "a fresh serve dates itself now");
});
