import assert from "node:assert/strict";
import test from "node:test";

import { mapApiFootballMatchDetail, mapApiFootballMatches } from "../src/mapApiFootball.js";

test("live matches include city and Google Maps link from the venue", () => {
  const [match] = mapApiFootballMatches({
    response: [
      {
        fixture: {
          id: 1,
          date: "2026-06-11T19:00:00Z",
          status: { short: "NS", elapsed: null },
          venue: { name: "SoFi Stadium", city: "Los Angeles" },
        },
        league: { round: "Group A - 1" },
        teams: { home: { name: "USA" }, away: { name: "Paraguay" } },
        goals: {},
        score: {},
      },
    ],
  });

  assert.equal(match.venue, "SoFi Stadium");
  assert.equal(match.city, "Los Angeles");
  assert.match(match.mapUrl, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/);
  assert.match(decodeURIComponent(match.mapUrl), /SoFi Stadium, Los Angeles/);
});

test("match detail includes city and Google Maps link from the venue", () => {
  const detail = mapApiFootballMatchDetail(
    {
      response: [{
        fixture: {
          id: 2,
          date: "2026-06-12T02:00:00Z",
          status: { short: "NS", elapsed: null },
          venue: { name: "BMO Field", city: "Toronto" },
        },
        league: { round: "Group B - 1" },
        teams: { home: { name: "Canada" }, away: { name: "Italy" } },
        goals: {},
        score: {},
      }],
    },
    { response: [] },
    { response: [] },
    { response: [] },
  );

  assert.equal(detail.city, "Toronto");
  assert.match(decodeURIComponent(detail.mapUrl), /BMO Field, Toronto/);
});
