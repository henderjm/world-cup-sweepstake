import assert from "node:assert/strict";
import test from "node:test";
import { localDateKey, readScoreRoute, scoreRouteHash, shiftScoreDate, validScoreDate } from "../src/scoreDates.js";
import { renderLive } from "../src/views.js";

process.env.TZ = "Europe/Dublin";

test("date keys use the viewer's local day, including a UTC kickoff after local midnight", () => {
  assert.equal(localDateKey("2026-09-10T23:30:00Z"), "2026-09-11");
});

test("date navigation crosses DST and month boundaries by calendar day", () => {
  assert.equal(shiftScoreDate("2026-03-28", 1), "2026-03-29");
  assert.equal(shiftScoreDate("2026-03-29", 1), "2026-03-30");
  assert.equal(shiftScoreDate("2026-10-25", 1), "2026-10-26");
  assert.equal(shiftScoreDate("2026-12-31", 1), "2027-01-01");
});

test("invalid route dates cannot silently roll into another month", () => {
  for (const date of ["2026-02-29", "2026-04-31", "tomorrow", "2026-13-01", ""]) assert.equal(validScoreDate(date), false);
  assert.equal(validScoreDate("2028-02-29"), true);
  assert.deepEqual(readScoreRoute("live?date=2026-02-30&live=1"), { tab: "live", followingOnly: false, date: null, liveOnly: true, competition: null });
});

test("date and live filter round-trip through shareable browser routes", () => {
  assert.deepEqual(readScoreRoute(scoreRouteHash("2026-09-10", true)), { tab: "live", followingOnly: false, date: "2026-09-10", liveOnly: true, competition: null });
  assert.equal(scoreRouteHash(null, false), "live");
  assert.equal(readScoreRoute("fantasy/12/feed"), null);
});

test("selected date and live filter show only matching fixtures, without duplicate recent rows", () => {
  const model = { matches: [
    { id: 1, homeTeam: "Home", awayTeam: "Away", utcDate: "2026-09-10T19:00Z", status: "IN_PLAY", score: { home: 1, away: 0 } },
    { id: 2, homeTeam: "Other", awayTeam: "Club", utcDate: "2026-09-10T16:00Z", status: "FINISHED", score: { home: 0, away: 0 } },
    { id: 3, homeTeam: "Tomorrow", awayTeam: "Visitors", utcDate: "2026-09-10T23:30Z", status: "TIMED", score: {} },
  ] };
  const day = renderLive(model, { date: "2026-09-10" });
  assert.equal((day.match(/data-match-id="2"/g) ?? []).length, 1);
  assert.doesNotMatch(day, /data-match-id="3"/);
  const live = renderLive(model, { tab: "live", followingOnly: false, date: "2026-09-10", liveOnly: true, competition: null });
  assert.match(live, /data-match-id="1"/);
  assert.doesNotMatch(live, /data-match-id="2"/);
});
