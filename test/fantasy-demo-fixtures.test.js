import assert from "node:assert/strict";
import test from "node:test";

import {
  AWAY_DISADVANTAGE,
  buildFixtureIndex,
  clubFixture,
  deriveClubStrength,
  fixtureDifficultyMultiplier,
  HOME_ADVANTAGE,
  standingsMapFromRawPayload,
} from "../src/fantasyDemoFixtures.js";

const MATCHES = [
  { matchday: 1, homeTeam: "Arsenal", awayTeam: "Chelsea" },
  { matchday: 1, homeTeam: "Man City", awayTeam: "Everton" },
  { matchday: 2, homeTeam: "Chelsea", awayTeam: "Man City" },
  // Arsenal has no fixture in gameweek 2 - a genuine blank gameweek.
];

test("buildFixtureIndex/clubFixture joins a club to its home fixture, with opponent and isHome", () => {
  const index = buildFixtureIndex(MATCHES);
  assert.deepEqual(clubFixture(index, "Arsenal", 1), { opponent: "Chelsea", isHome: true });
});

test("buildFixtureIndex/clubFixture joins a club to its away fixture", () => {
  const index = buildFixtureIndex(MATCHES);
  assert.deepEqual(clubFixture(index, "Chelsea", 1), { opponent: "Arsenal", isHome: false });
});

test("clubFixture returns null for a blank gameweek (no fixture that matchday)", () => {
  const index = buildFixtureIndex(MATCHES);
  assert.equal(clubFixture(index, "Arsenal", 2), null);
});

test("clubFixture normalizes the team name before joining, so a short provider spelling still matches", () => {
  const index = buildFixtureIndex([{ matchday: 1, homeTeam: "Coventry City", awayTeam: "Leeds United" }]);
  // data/PL/players.json ships the short forms for these two promoted clubs
  // (see the TEAM_ALIASES comment in domain.js); the join must still work.
  assert.deepEqual(clubFixture(index, "Coventry", 1), { opponent: "Leeds United", isHome: true });
  assert.deepEqual(clubFixture(index, "Leeds", 1), { opponent: "Coventry City", isHome: false });
});

test("clubFixture is null (no crash) when no fixture index was built at all", () => {
  assert.equal(clubFixture(new Map(), "Arsenal", 1), null);
});

// -- Club strength ----------------------------------------------------------------

test("deriveClubStrength uses the real table once games have been played", () => {
  const standingsMap = new Map([
    ["Arsenal", { team: "Arsenal", position: 1, played: 5 }],
    ["Chelsea", { team: "Chelsea", position: 2, played: 5 }],
  ]);
  const strength = deriveClubStrength({ standingsMap, players: [] });
  assert.ok(strength.get("Arsenal") > strength.get("Chelsea"), "the top-of-table club should be strongest");
});

test("deriveClubStrength falls back to the player-tier proxy when nobody has played yet (preseason)", () => {
  const standingsMap = new Map([
    ["Arsenal", { team: "Arsenal", position: 1, played: 0 }],
    ["Chelsea", { team: "Chelsea", position: 2, played: 0 }],
  ]);
  const players = [
    { team: "Arsenal", tier: "starter" },
    { team: "Arsenal", tier: "starter" },
    { team: "Chelsea", tier: "fringe" },
    { team: "Chelsea", tier: "unknown" },
  ];
  const strength = deriveClubStrength({ standingsMap, players });
  assert.ok(
    strength.get("Arsenal") > strength.get("Chelsea"),
    "a squad of starters should be derived as stronger than a squad of fringe/unknown players",
  );
});

test("deriveClubStrength normalizes player team names before grouping (Coventry vs Coventry City)", () => {
  const players = [
    { team: "Coventry", tier: "starter" },
    { team: "Coventry City", tier: "starter" },
    { team: "Arsenal", tier: "fringe" },
  ];
  const strength = deriveClubStrength({ standingsMap: new Map(), players });
  // Both spellings must collapse onto the SAME canonical key, or Coventry's
  // two players would be split into two separate half-strength clubs.
  assert.equal(strength.has("Coventry"), false);
  assert.ok(strength.has("Coventry City"));
});

test("standingsMapFromRawPayload reuses domain.js's mapStandings against a raw live.json-shaped payload", () => {
  const raw = {
    standings: [
      {
        type: "TOTAL",
        table: [{ position: 1, playedGames: 3, team: { name: "Arsenal FC", shortName: "Arsenal" } }],
      },
    ],
  };
  const standingsMap = standingsMapFromRawPayload(raw);
  assert.equal(standingsMap.get("Arsenal").played, 3);
});

// -- Fixture difficulty -------------------------------------------------------------

test("fixtureDifficultyMultiplier returns a neutral 1x when opponent strength is unknown", () => {
  assert.equal(fixtureDifficultyMultiplier(null, true), 1);
});

test("fixtureDifficultyMultiplier favours a home fixture over the identical away fixture", () => {
  const home = fixtureDifficultyMultiplier(0.5, true);
  const away = fixtureDifficultyMultiplier(0.5, false);
  assert.ok(home > away);
  assert.ok(Math.abs(home - away - (HOME_ADVANTAGE - AWAY_DISADVANTAGE)) < 1e-9);
});

test("fixtureDifficultyMultiplier favours a weaker opponent over a stronger one", () => {
  const easy = fixtureDifficultyMultiplier(0.1, true);
  const hard = fixtureDifficultyMultiplier(0.9, true);
  assert.ok(easy > hard, "a weak opponent should lift the multiplier above a tough opponent's");
});

test("fixtureDifficultyMultiplier stays within its documented clamp for extreme inputs", () => {
  assert.ok(fixtureDifficultyMultiplier(0, true) <= 1.6);
  assert.ok(fixtureDifficultyMultiplier(1, false) >= 0.5);
});
