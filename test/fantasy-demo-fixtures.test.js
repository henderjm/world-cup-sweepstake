import assert from "node:assert/strict";
import test from "node:test";

import {
  AWAY_DISADVANTAGE,
  buildFixtureIndex,
  clubFixture,
  deriveClubStrength,
  fixtureDifficultyMultiplier,
  HOME_ADVANTAGE,
  NEUTRAL_CLUB_STRENGTH,
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

// The four tests below replace one that asserted a preseason tier-average
// proxy ranked a squad of starters above a squad of fringe players. That proxy
// was removed deliberately, not weakened: averaged over a whole squad it
// measured continuity rather than quality, and against the real July 2026 pool
// it made Man United the toughest fixture in the league and Leeds third. Tier
// cannot stand in either, having only four levels, so every established club
// ties at the top. Expected points is the signal now, and absent it the model
// says nothing rather than something wrong.

test("deriveClubStrength ranks preseason clubs by their best XI's expected points", () => {
  const standingsMap = new Map([
    ["Arsenal", { team: "Arsenal", position: 1, played: 0 }],
    ["Chelsea", { team: "Chelsea", position: 2, played: 0 }],
  ]);
  const players = [
    { team: "Arsenal", tier: "starter", xp: 6 },
    { team: "Arsenal", tier: "starter", xp: 5 },
    { team: "Chelsea", tier: "starter", xp: 2 },
    { team: "Chelsea", tier: "starter", xp: 1 },
  ];
  const strength = deriveClubStrength({ standingsMap, players });
  assert.ok(strength.get("Arsenal") > strength.get("Chelsea"), "the higher-xP squad should be stronger");
});

test("deriveClubStrength judges a club on its best XI, not on how deep its squad list is", () => {
  // Squad depth must not be a penalty. Both clubs field an identical best XI;
  // one merely has extra low-value players listed behind it, which is exactly
  // what the old whole-squad average punished.
  const eleven = (team, xp) => Array.from({ length: 11 }, () => ({ team, tier: "starter", xp }));
  const players = [
    ...eleven("Arsenal", 5),
    ...eleven("Chelsea", 5),
    { team: "Chelsea", tier: "fringe", xp: 0.1 },
    { team: "Chelsea", tier: "fringe", xp: 0.1 },
    { team: "Chelsea", tier: "fringe", xp: 0.1 },
  ];
  const strength = deriveClubStrength({ players });
  assert.equal(strength.get("Arsenal"), strength.get("Chelsea"), "extra squad players must not weaken a club");
});

test("deriveClubStrength goes neutral rather than inventing a pecking order when no xP exists", () => {
  // The shipped pool has xp null for every player until a bake runs, so this
  // is today's real path. A confidently wrong difficulty model is worse than
  // an openly neutral one: a user checks it against their own knowledge of the
  // league and then stops believing the rest of the app.
  const players = [
    { team: "Arsenal", tier: "starter" },
    { team: "Chelsea", tier: "fringe" },
    { team: "Ipswich Town", tier: "unknown" },
  ];
  const strength = deriveClubStrength({ players });
  const values = [...strength.values()];
  assert.equal(new Set(values).size, 1, "every club should be equally strong when we know nothing");
  assert.equal(values[0], NEUTRAL_CLUB_STRENGTH);
});

test("a neutral strength model leaves home advantage as the only fixture signal", () => {
  const home = fixtureDifficultyMultiplier(NEUTRAL_CLUB_STRENGTH, true);
  const away = fixtureDifficultyMultiplier(NEUTRAL_CLUB_STRENGTH, false);
  assert.ok(home > away, "home should still beat away when opponents are indistinguishable");
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
