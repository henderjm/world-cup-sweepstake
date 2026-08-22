import assert from "node:assert/strict";
import test from "node:test";

import {
  OVERDUE_GRACE_MS,
  feedDelayNotice,
  isOverdueFixture,
  isPreMatch,
  overdueFixtures,
} from "../src/fixtureFreshness.js";

// The bug: a Hull City v Man United match well into the second half rendered as
// "not kicked off", with a tidy kickoff time beside it. The app was stating
// something false as fact.
//
// Worth recording why, because the symptom invites the wrong diagnosis: nothing
// decides kicked-off-ness from a clock. statusLabel reads the provider's `status`,
// and NS maps to TIMED, so a timezone offset cannot cause this — only a stale
// status can. When the Worker cannot reach upstream the browser falls back to the
// hourly static bake, and a bake written before kickoff says TIMED forever.

const NOW = Date.parse("2026-08-22T12:20:00.000Z");
const at = (iso, status = "TIMED", extra = {}) => ({
  homeTeam: "Hull City",
  awayTeam: "Man United",
  status,
  utcDate: iso,
  ...extra,
});

test("a fixture well past kickoff but still pre-match is overdue", () => {
  assert.equal(isOverdueFixture(at("2026-08-22T11:30:00.000Z"), NOW), true);
});

test("a fixture that has not kicked off yet is not overdue", () => {
  assert.equal(isOverdueFixture(at("2026-08-22T16:30:00.000Z"), NOW), false);
  // Right on the whistle, and just after: inside the grace, so still trusted.
  assert.equal(isOverdueFixture(at(new Date(NOW).toISOString()), NOW), false);
  assert.equal(isOverdueFixture(at(new Date(NOW - OVERDUE_GRACE_MS).toISOString()), NOW), false);
  assert.equal(isOverdueFixture(at(new Date(NOW - OVERDUE_GRACE_MS - 1).toISOString()), NOW), true);
});

test("a match the feed already knows about is never overdue", () => {
  // Live, finished and awarded all mean the feed is keeping up, whatever the clock
  // says. Only a PRE-MATCH status can be contradicted by the clock.
  for (const status of ["IN_PLAY", "PAUSED", "EXTRA_TIME", "FINISHED", "AWARDED"]) {
    assert.equal(isOverdueFixture(at("2026-08-22T11:30:00.000Z", status), NOW), false, status);
  }
});

test("postponed and cancelled fixtures are never overdue", () => {
  // These keep their original kickoff time forever, so treating them as overdue
  // would put a warning on every abandoned game for the rest of the season.
  assert.equal(isOverdueFixture(at("2026-08-22T11:30:00.000Z", "POSTPONED"), NOW), false);
  assert.equal(isOverdueFixture(at("2026-08-22T11:30:00.000Z", "CANCELLED"), NOW), false);
});

test("an unreadable or absent kickoff is not overdue", () => {
  // With no instant to compare against we know nothing, and guessing would flag
  // fixtures that never had a time.
  assert.equal(isOverdueFixture(at("not a date"), NOW), false);
  assert.equal(isOverdueFixture({ status: "TIMED" }, NOW), false);
  assert.equal(isOverdueFixture(null, NOW), false);
  assert.equal(isOverdueFixture(undefined, NOW), false);
});

test("isPreMatch covers both pre-match spellings and nothing else", () => {
  assert.equal(isPreMatch("TIMED"), true);
  assert.equal(isPreMatch("SCHEDULED"), true);
  assert.equal(isPreMatch("IN_PLAY"), false);
  assert.equal(isPreMatch("POSTPONED"), false);
  assert.equal(isPreMatch(undefined), false);
});

test("overdueFixtures picks out only the ones we have lost track of", () => {
  const matches = [
    at("2026-08-22T11:30:00.000Z"), // overdue
    at("2026-08-22T16:30:00.000Z"), // later today
    at("2026-08-22T10:00:00.000Z", "FINISHED"),
    at("2026-08-22T11:00:00.000Z", "IN_PLAY"),
  ];
  assert.equal(overdueFixtures(matches, NOW).length, 1);
  assert.equal(overdueFixtures([], NOW).length, 0);
  assert.equal(overdueFixtures(null, NOW).length, 0);
});

// -- the notice --------------------------------------------------------------

test("no notice when everything is believable", () => {
  assert.equal(feedDelayNotice({ matches: [at("2026-08-22T16:30:00.000Z")], now: NOW }), null);
  assert.equal(feedDelayNotice({ matches: [], now: NOW }), null);
  assert.equal(feedDelayNotice({ now: NOW }), null);
});

test("an overdue fixture raises a notice with how far behind we are", () => {
  const notice = feedDelayNotice({ matches: [at("2026-08-22T11:30:00.000Z")], now: NOW });
  assert.equal(notice.overdue.length, 1);
  assert.equal(notice.stale, false);
  assert.equal(Math.round(notice.behindByMs / 60000), 50);
});

test("the Worker's own stale marker raises a notice on its own", () => {
  // The two signals are independent, and this one matters because the static-bake
  // path carries no marker at all: a file cannot know it is old.
  const notice = feedDelayNotice({
    matches: [at("2026-08-22T16:30:00.000Z")],
    stale: true,
    staleAgeMs: 120_000,
    now: NOW,
  });
  assert.ok(notice);
  assert.equal(notice.stale, true);
  assert.equal(notice.overdue.length, 0);
  assert.equal(notice.behindByMs, 120_000);
});

test("with several overdue fixtures the worst lag is reported", () => {
  const notice = feedDelayNotice({
    matches: [at("2026-08-22T11:30:00.000Z"), at("2026-08-22T10:00:00.000Z")],
    now: NOW,
  });
  assert.equal(notice.overdue.length, 2);
  assert.equal(Math.round(notice.behindByMs / 60000), 140);
});

// -- the rendering -----------------------------------------------------------

test("the live view names the match instead of showing a bare kickoff time", async () => {
  const { renderLive } = await import("../src/views.js");
  const model = {
    competition: { name: "Premier League", zones: [] },
    matches: [
      { id: 1, homeTeam: "Hull City", awayTeam: "Man United", status: "TIMED", utcDate: new Date(Date.now() - 50 * 60_000).toISOString(), score: {} },
    ],
    standings: new Map(),
    tables: [],
    scorers: [],
  };
  const html = renderLive(model);
  assert.match(html, /Live data is behind/);
  assert.match(html, /Hull City v Man United/);
  assert.match(html, /is-overdue/);
  // And it must not invent a scoreline for a match it cannot see.
  assert.doesNotMatch(html, /livegrid/);
});

test("a healthy card of fixtures raises nothing", async () => {
  const { renderLive } = await import("../src/views.js");
  const model = {
    competition: { name: "Premier League", zones: [] },
    matches: [
      { id: 2, homeTeam: "Arsenal", awayTeam: "Chelsea", status: "TIMED", utcDate: new Date(Date.now() + 4 * 3600_000).toISOString(), score: {} },
    ],
    standings: new Map(),
    tables: [],
    scorers: [],
  };
  const html = renderLive(model);
  assert.doesNotMatch(html, /Live data is behind/);
  assert.doesNotMatch(html, /is-overdue/);
});
