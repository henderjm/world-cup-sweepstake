import assert from "node:assert/strict";
import test from "node:test";

import { mapFootballDataMatches } from "../src/domain.js";
import { mapMatchDetail } from "../src/mapDetail.js";

test("live matches include city and Google Maps link from the venue", () => {
  const [match] = mapFootballDataMatches({
    matches: [
      {
        id: 1,
        utcDate: "2026-06-11T19:00:00Z",
        status: "TIMED",
        stage: "GROUP_STAGE",
        group: "GROUP_A",
        venue: "SoFi Stadium",
        homeTeam: { name: "USA" },
        awayTeam: { name: "Paraguay" },
        score: {},
      },
    ],
  });

  assert.equal(match.venue, "SoFi Stadium");
  assert.equal(match.city, "Los Angeles");
  assert.match(match.mapUrl, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/);
  assert.match(decodeURIComponent(match.mapUrl), /SoFi Stadium Los Angeles/);
});

test("match detail includes city and Google Maps link from the venue", () => {
  const detail = mapMatchDetail({
    id: 2,
    utcDate: "2026-06-12T02:00:00Z",
    status: "TIMED",
    stage: "GROUP_STAGE",
    venue: "BMO Field",
    score: {},
    homeTeam: {},
    awayTeam: {},
  });

  assert.equal(detail.city, "Toronto");
  assert.match(decodeURIComponent(detail.mapUrl), /BMO Field Toronto/);
});
