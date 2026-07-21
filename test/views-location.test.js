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
