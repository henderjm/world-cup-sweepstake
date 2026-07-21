import assert from "node:assert/strict";
import test from "node:test";

import { renderFixtures } from "../src/views.js";

test("fixtures render the match city as a Google Maps link", () => {
  const html = renderFixtures({
    matches: [
      {
        id: 99,
        utcDate: "2026-06-11T19:00:00Z",
        status: "TIMED",
        stage: "GROUP_STAGE",
        group: "GROUP_A",
        homeTeam: "Mexico",
        awayTeam: "South Africa",
        score: { home: null, away: null },
        city: "Mexico City",
        mapUrl: "https://www.google.com/maps/search/?api=1&query=Estadio%20Azteca%20Mexico%20City",
      },
    ],
  }, "upcoming");

  assert.match(html, /data-map-link/);
  assert.match(html, /Mexico City/);
  assert.match(html, /https:\/\/www\.google\.com\/maps\/search\/\?api=1&amp;query=Estadio%20Azteca%20Mexico%20City/);
});
