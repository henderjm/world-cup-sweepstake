import assert from "node:assert/strict";
import test from "node:test";

import { renderFixtures } from "../src/views.js";

test("fixtures render day sections with both teams and kickoff time", () => {
  const html = renderFixtures({
    matches: [
      {
        id: 99,
        utcDate: "2026-08-22T14:00:00Z",
        status: "TIMED",
        stage: "REGULAR_SEASON",
        group: null,
        matchday: 1,
        homeTeam: "Arsenal",
        awayTeam: "Coventry City",
        score: { home: null, away: null },
      },
    ],
  }, "upcoming");

  assert.match(html, /fxday/);
  assert.match(html, /Arsenal/);
  assert.match(html, /Coventry City/);
  assert.match(html, /data-match-id="99"/);
});

// -- Fixtures club filter (issue #36) ----------------------------------------

test("renderFixtures offers every club in the competition, plus All", () => {
  const model = {
    matches: [
      { id: 1, utcDate: "2026-08-21T19:00:00Z", status: "TIMED", homeTeam: "Arsenal", awayTeam: "Coventry City", score: {} },
      { id: 2, utcDate: "2026-08-22T14:00:00Z", status: "TIMED", homeTeam: "Everton", awayTeam: "Arsenal", score: {} },
    ],
  };
  const html = renderFixtures(model, "upcoming", "All");
  assert.match(html, /data-fixture-team/);
  assert.match(html, /<option value="All" selected>All clubs<\/option>/);
  assert.match(html, /<option value="Arsenal">Arsenal<\/option>/);
  assert.match(html, /<option value="Coventry City">Coventry City<\/option>/);
  assert.match(html, /<option value="Everton">Everton<\/option>/);
});

test("renderFixtures narrows to one club's fixtures, home and away alike", () => {
  const model = {
    matches: [
      { id: 1, utcDate: "2026-08-21T19:00:00Z", status: "TIMED", homeTeam: "Arsenal", awayTeam: "Coventry City", score: {} },
      { id: 2, utcDate: "2026-08-22T14:00:00Z", status: "TIMED", homeTeam: "Everton", awayTeam: "Arsenal", score: {} },
      { id: 3, utcDate: "2026-08-23T14:00:00Z", status: "TIMED", homeTeam: "Everton", awayTeam: "Coventry City", score: {} },
    ],
  };
  const html = renderFixtures(model, "upcoming", "Arsenal");
  assert.match(html, /Coventry City/); // match 1, Arsenal at home
  assert.match(html, /Everton/); // match 2, Arsenal away
  // Match 3 involves neither, so it must be gone: its day heading is the tell.
  assert.equal(/23 Aug|Aug 23/.test(html), false, "a fixture without the selected club leaked through");
});

test("renderFixtures counts describe the filtered list, not the whole competition", () => {
  const model = {
    matches: [
      { id: 1, utcDate: "2026-08-21T19:00:00Z", status: "TIMED", homeTeam: "Arsenal", awayTeam: "Coventry City", score: {} },
      { id: 2, utcDate: "2026-08-22T14:00:00Z", status: "TIMED", homeTeam: "Everton", awayTeam: "Fulham", score: {} },
    ],
  };
  assert.match(renderFixtures(model, "upcoming", "All"), /Upcoming <span class="seg__count">\(2\)/);
  assert.match(renderFixtures(model, "upcoming", "Arsenal"), /Upcoming <span class="seg__count">\(1\)/);
});

test("an unknown club falls back to All rather than rendering an empty page", () => {
  const model = {
    matches: [{ id: 1, utcDate: "2026-08-21T19:00:00Z", status: "TIMED", homeTeam: "Arsenal", awayTeam: "Everton", score: {} }],
  };
  const html = renderFixtures(model, "upcoming", "Relegated Athletic");
  assert.match(html, /<option value="All" selected>/);
  assert.match(html, /Arsenal/);
});

test("a club with nothing in this view says so by name", () => {
  const model = {
    matches: [{ id: 1, utcDate: "2026-08-21T19:00:00Z", status: "TIMED", homeTeam: "Arsenal", awayTeam: "Everton", score: {} }],
  };
  assert.match(renderFixtures(model, "results", "Arsenal"), /No results yet for Arsenal\./);
});
