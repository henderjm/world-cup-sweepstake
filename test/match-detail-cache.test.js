import assert from "node:assert/strict";
import test from "node:test";

import {
  MATCH_DETAIL_FINISHED,
  MATCH_DETAIL_IMMINENT_MS,
  MATCH_DETAIL_LIVE,
  MATCH_DETAIL_UPCOMING,
  matchDetailCacheProfile,
} from "../src/matchDetailCache.js";

const NOW = new Date("2026-08-22T15:00:00Z").getTime();
const at = (iso, status = "TIMED") => ({ status, utcDate: iso });

test("a live match keeps the short, minute-fresh windows", () => {
  const profile = matchDetailCacheProfile({ status: "IN_PLAY", utcDate: "2026-08-22T14:00:00Z" }, NOW);
  assert.equal(profile, MATCH_DETAIL_LIVE);
});

test("a match about to kick off keeps the short windows", () => {
  const profile = matchDetailCacheProfile(at("2026-08-22T15:30:00Z"), NOW);
  assert.equal(profile, MATCH_DETAIL_LIVE);
});

test("a match that kicked off in the recent past is still treated as live", () => {
  // Status can lag the clock, so a fixture whose kickoff has passed but which
  // is not marked finished must not be given long windows.
  const profile = matchDetailCacheProfile(at("2026-08-22T14:45:00Z"), NOW);
  assert.equal(profile, MATCH_DETAIL_LIVE);
});

test("a finished match gets long windows, because its detail no longer changes", () => {
  assert.equal(matchDetailCacheProfile(at("2026-08-21T19:00:00Z", "FINISHED"), NOW), MATCH_DETAIL_FINISHED);
});

test("an awarded match counts as finished, matching how scoring treats it", () => {
  assert.equal(matchDetailCacheProfile(at("2026-08-21T19:00:00Z", "AWARDED"), NOW), MATCH_DETAIL_FINISHED);
});

test("a fixture days away gets long windows: it has no lineups or events to return", () => {
  assert.equal(matchDetailCacheProfile(at("2026-08-29T15:00:00Z"), NOW), MATCH_DETAIL_UPCOMING);
});

test("the boundary is the imminent window, and it is inclusive", () => {
  const justInside = new Date(NOW + MATCH_DETAIL_IMMINENT_MS).toISOString();
  const justOutside = new Date(NOW + MATCH_DETAIL_IMMINENT_MS + 1000).toISOString();
  assert.equal(matchDetailCacheProfile(at(justInside), NOW), MATCH_DETAIL_LIVE);
  assert.equal(matchDetailCacheProfile(at(justOutside), NOW), MATCH_DETAIL_UPCOMING);
});

test("malformed timing falls back to the live profile, never to a long cache", () => {
  // Erring the other way would serve a stale drawer during a real match. The
  // safe failure here is spending calls, not showing wrong scores.
  assert.equal(matchDetailCacheProfile({ status: "TIMED", utcDate: "not a date" }, NOW), MATCH_DETAIL_LIVE);
});

test("a missing match does not throw", () => {
  assert.equal(matchDetailCacheProfile(null, NOW), MATCH_DETAIL_UPCOMING);
});

test("the whole point: almost no fixture in a season is on the expensive profile", () => {
  // The attack this defends against is cycling every fixture id. Model a real
  // 380-match season around one matchday and confirm the expensive profile
  // applies to a tiny minority, so enumeration buys almost nothing.
  const matches = [];
  for (let i = 0; i < 380; i++) {
    const day = Math.floor(i / 10);
    const kickoff = new Date(Date.UTC(2026, 7, 8) + day * 7 * 86400000 + 15 * 3600000);
    const status = kickoff.getTime() < NOW ? "FINISHED" : "TIMED";
    matches.push({ status, utcDate: kickoff.toISOString() });
  }
  const live = matches.filter((match) => matchDetailCacheProfile(match, NOW) === MATCH_DETAIL_LIVE).length;
  assert.ok(live <= 10, `expected at most one matchday on short windows, got ${live}`);
  assert.ok(
    live / matches.length < 0.05,
    `the expensive profile should cover under 5% of the season, got ${((live / matches.length) * 100).toFixed(1)}%`,
  );
});

test("every profile covers all four upstream payloads, so none silently defaults", () => {
  for (const profile of [MATCH_DETAIL_LIVE, MATCH_DETAIL_FINISHED, MATCH_DETAIL_UPCOMING]) {
    for (const key of ["fixture", "lineups", "events", "players"]) {
      assert.equal(typeof profile[key], "number", `${key} missing`);
      assert.ok(profile[key] > 0);
    }
  }
});

test("the cheap profiles really are cheaper than the live one on every payload", () => {
  for (const key of ["fixture", "lineups", "events", "players"]) {
    assert.ok(MATCH_DETAIL_FINISHED[key] >= MATCH_DETAIL_LIVE[key], `${key} not longer when finished`);
    assert.ok(MATCH_DETAIL_UPCOMING[key] >= MATCH_DETAIL_LIVE[key], `${key} not longer when upcoming`);
  }
});
