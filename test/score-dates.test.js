import assert from "node:assert/strict";
import test from "node:test";
import { localDateKey, readScoreRoute, scoreRouteHash, shiftScoreDate, validScoreDate } from "../src/scoreDates.js";
import { renderLive, renderScoresHome } from "../src/views.js";

process.env.TZ = "Europe/Dublin";

test("date keys use the viewer's local day, including a UTC kickoff after local midnight", () => {
  assert.equal(localDateKey("2026-09-10T23:30:00Z"), "2026-09-11");
});

test("Today keeps yesterday's ongoing matches visible after local midnight", t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-09-19T23:05:00Z'));
  const model = { competition: { code: 'CL', shortName: 'Champions League' }, hasData: true, matches: [
    { id: 1, homeTeam: 'Home', awayTeam: 'Away', utcDate: '2026-09-19T21:30Z', status: 'EXTRA_TIME', score: { home: 2, away: 2 } },
    { id: 2, homeTeam: 'Finished', awayTeam: 'Away', utcDate: '2026-09-19T20:00Z', status: 'FINISHED', score: { home: 1, away: 0 } },
    { id: 3, homeTeam: 'Old', awayTeam: 'Away', utcDate: '2026-09-18T21:00Z', status: 'IN_PLAY', score: { home: 0, away: 0 } },
  ] };
  for (const html of [renderLive(model), renderLive(model, { liveOnly: true }), renderScoresHome([model])]) {
    assert.match(html, /data-match-id="1"/);
    assert.match(html, /still live from yesterday/);
    assert.match(html, /seg__count">1</);
    assert.doesNotMatch(html, /data-match-id="[23]"/);
  }
  const history = renderLive(model, { date: '2026-09-19' });
  assert.match(history, /data-match-id="2"/);
  assert.doesNotMatch(history, /still live from yesterday/);
  model.matches[0].status = 'FINISHED';
  assert.doesNotMatch(renderLive(model), /data-match-id="1"/);
  assert.match(renderLive(model, { date: '2026-09-19' }), /data-match-id="1"/);
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
  assert.deepEqual(readScoreRoute("live?date=2026-02-30&live=1"), { tab: "live", phase: null, round: null, followingOnly: false, date: null, liveOnly: true, competition: null });
});

test("date and live filter round-trip through shareable browser routes", () => {
  assert.deepEqual(readScoreRoute(scoreRouteHash({ date: "2026-09-10", liveOnly: true })), { tab: "live", phase: null, round: null, followingOnly: false, date: "2026-09-10", liveOnly: true, competition: null });
  assert.equal(scoreRouteHash(), "live");
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
  const live = renderLive(model, { tab: "live", phase: null, round: null, followingOnly: false, date: "2026-09-10", liveOnly: true, competition: null });
  assert.match(live, /data-match-id="1"/);
  assert.doesNotMatch(live, /data-match-id="2"/);
});

test('empty-day shortcuts preserve competition and Following while showing upcoming fixtures outside Live', () => {
  const model = { competition: { code: 'CL', shortName: 'Champions League' }, hasData: true, matches: [
    { id: 30, homeTeam: 'Lens', awayTeam: 'Sporting CP', utcDate: '2026-10-13T17:45:00Z', status: 'TIMED' },
    { id: 31, homeTeam: 'Arsenal', awayTeam: 'Lille', utcDate: '2026-10-13T20:00:00Z', status: 'TIMED' },
  ] };
  const options = { date: '2026-10-04', liveOnly: true, followingOnly: true, follows: [{ competition: 'CL', team: 'Arsenal' }] };
  const html = renderLive(model, options);
  assert.match(html, /Next: Arsenal v Lille/);
  assert.doesNotMatch(html, /Next: Lens/);
  const href = html.match(/href="#([^"]+)">View upcoming matches/)[1].replaceAll('&amp;', '&');
  assert.deepEqual(readScoreRoute(href), { tab: 'live', competition: 'CL', date: '2026-10-13', followingOnly: true, liveOnly: false, phase: null, round: null });
  const combined = renderScoresHome([model], options);
  const combinedRoute = combined.match(/href="#([^"]+)">View upcoming matches/)[1].replaceAll('&amp;', '&');
  assert.equal(readScoreRoute(combinedRoute).competition, null);
  const sameDay = renderLive(model, { date: '2026-10-13', liveOnly: true });
  assert.match(sameDay, /View upcoming matches/);
  assert.doesNotMatch(renderLive(model, { date: '2026-10-13' }), /View upcoming matches/);
  assert.doesNotMatch(renderLive(model, { date: '2026-10-14' }), /View upcoming matches/);
});
