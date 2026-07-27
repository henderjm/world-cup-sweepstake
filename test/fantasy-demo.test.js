import assert from "node:assert/strict";
import test from "node:test";

import { SQUAD_SIZE, SQUAD_SLOTS } from "../src/fantasy.js";
import {
  applyDemoPick,
  autoPickForRoom,
  buildDemoReportCard,
  composeDemoShareText,
  createDemoMembers,
  DEFAULT_DEMO_CLOCK_SECONDS,
  DEFAULT_DEMO_MANAGER_NAME,
  DEMO_CLOCK_SECONDS_OPTIONS,
  DEMO_CLOCK_UNTIMED,
  DEMO_HUMAN_ID,
  demoClockDurationMs,
  draftedPlayerIds,
  initDemoDraftRoom,
  isDemoDraftComplete,
  seededPlayerGameweekPoints,
  simulateDemoSeason,
} from "../src/fantasyDemo.js";

// -- Setup --------------------------------------------------------------------

test("createDemoMembers falls back to a default name for blank input", () => {
  const { members, humanId } = createDemoMembers(4, "   ");
  assert.equal(humanId, DEMO_HUMAN_ID);
  assert.equal(members[0].name, DEFAULT_DEMO_MANAGER_NAME);
});

test("createDemoMembers keeps a real name and marks bots distinctly", () => {
  const { members } = createDemoMembers(6, "Gaffer");
  assert.equal(members.length, 6);
  assert.equal(members[0].userId, DEMO_HUMAN_ID);
  assert.equal(members[0].name, "Gaffer");
  assert.equal(members[0].isBot, false);
  assert.equal(members.slice(1).every((member) => member.isBot), true);
  // Every id is unique.
  assert.equal(new Set(members.map((member) => member.userId)).size, 6);
});

// -- Pick clock choice ------------------------------------------------------------

test("demoClockDurationMs converts a timed choice to milliseconds", () => {
  for (const seconds of DEMO_CLOCK_SECONDS_OPTIONS) {
    assert.equal(demoClockDurationMs(seconds), seconds * 1000);
  }
  assert.equal(demoClockDurationMs(DEFAULT_DEMO_CLOCK_SECONDS), DEFAULT_DEMO_CLOCK_SECONDS * 1000);
});

test("demoClockDurationMs returns null for the untimed option", () => {
  assert.equal(demoClockDurationMs(DEMO_CLOCK_UNTIMED), null);
});

test("demoClockDurationMs returns null for a missing or bogus choice rather than guessing a default", () => {
  assert.equal(demoClockDurationMs(null), null);
  assert.equal(demoClockDurationMs(undefined), null);
  assert.equal(demoClockDurationMs("not-a-number"), null);
  assert.equal(demoClockDurationMs(0), null);
  assert.equal(demoClockDurationMs(-30), null);
});

test("demoClockDurationMs accepts a stringified number (setup buttons carry the choice as a data attribute string)", () => {
  assert.equal(demoClockDurationMs("30"), 30000);
});

// -- Draft ----------------------------------------------------------------------

function buildPool({ gk = 30, def = 80, mid = 80, fwd = 50 } = {}) {
  const tiers = ["starter", "squad", "unknown", "fringe"];
  const players = [];
  let id = 1;
  const add = (position, count) => {
    for (let i = 0; i < count; i++) {
      players.push({ id: id++, name: `${position}-${i}`, team: `Club ${i % 20}`, position, tier: tiers[i % tiers.length] });
    }
  };
  add("GK", gk);
  add("DEF", def);
  add("MID", mid);
  add("FWD", fwd);
  return players;
}

function runFullDraft(size, pool) {
  const { members } = createDemoMembers(size, "Tester");
  const memberIds = members.map((member) => member.userId);
  let room = initDemoDraftRoom(memberIds);
  const maxPicks = size * SQUAD_SIZE;
  for (let i = 0; i < maxPicks && !isDemoDraftComplete(room); i++) {
    const pick = autoPickForRoom(room, pool);
    assert.ok(pick, `expected a legal autopick at overall pick ${room.overallPick}`);
    room = applyDemoPick(room, pick);
  }
  return { room, members };
}

test("a full autopicked demo draft always leaves every manager with a legal 15-player squad", () => {
  const pool = buildPool();
  const { room, members } = runFullDraft(8, pool);
  assert.equal(isDemoDraftComplete(room), true);
  for (const member of members) {
    const roster = room.rosters[member.userId];
    assert.equal(roster.length, SQUAD_SIZE, `${member.userId} should have exactly ${SQUAD_SIZE} players`);
    const counts = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
    for (const player of roster) counts[player.position] += 1;
    assert.deepEqual(counts, SQUAD_SLOTS, `${member.userId} should match SQUAD_SLOTS exactly`);
  }
  // Nobody was drafted twice.
  const allIds = Object.values(room.rosters).flat().map((player) => player.id);
  assert.equal(new Set(allIds).size, allIds.length);
});

test("a full autopicked demo draft is legal for the smallest and largest league sizes", () => {
  const pool = buildPool();
  for (const size of [4, 6, 8]) {
    const { room, members } = runFullDraft(size, pool);
    assert.equal(isDemoDraftComplete(room), true);
    for (const member of members) {
      assert.equal(room.rosters[member.userId].length, SQUAD_SIZE);
    }
  }
});

test("applyDemoPick rejects a player already drafted anywhere in the room", () => {
  const pool = buildPool();
  const { members } = createDemoMembers(4, "Tester");
  const memberIds = members.map((member) => member.userId);
  let room = initDemoDraftRoom(memberIds);
  const player = pool.find((candidate) => candidate.position === "GK");
  room = applyDemoPick(room, player);
  const afterFirstPick = room;
  const again = applyDemoPick(room, player);
  assert.equal(again, afterFirstPick, "a duplicate pick should be a no-op, not a second entry");
  assert.equal(draftedPlayerIds(again).size, 1);
});

test("applyDemoPick rejects a pick into an already-full position bucket", () => {
  const pool = buildPool();
  const { members } = createDemoMembers(4, "Tester");
  const memberIds = members.map((member) => member.userId);
  let room = initDemoDraftRoom(memberIds);
  // Draft SQUAD_SLOTS.GK (2) keepers for whoever is on the clock first, then
  // try to force a third onto that same manager - it must be rejected.
  const gks = pool.filter((player) => player.position === "GK");
  const onClockFirst = room.onClockUserId;
  // Walk picks until it's onClockFirst's turn again after 2 GKs already went
  // to them specifically: simplest is to draft GK GK for every manager in
  // round 1 order is awkward with snake draft, so instead directly assert
  // against the pure rule: after 2 GKs land on the same roster via repeated
  // applyDemoPick calls interleaved with autopicks for other managers, a 3rd
  // is refused. To keep this deterministic and simple, draft the first two
  // GKs back-to-back is not possible in a real snake draft (turns alternate),
  // so we instead verify the underlying invariant directly: a manager whose
  // roster already holds 2 GKs cannot legally take a third, by round-tripping
  // through applyDemoPick with a hand-built room.
  const fullGkRoom = {
    ...room,
    rosters: { ...room.rosters, [onClockFirst]: [gks[0], gks[1]] },
  };
  const rejected = applyDemoPick(fullGkRoom, gks[2]);
  assert.equal(rejected, fullGkRoom);
});

// -- Seeded score generator -----------------------------------------------------

test("seededPlayerGameweekPoints is deterministic for identical inputs", () => {
  const a = seededPlayerGameweekPoints("seed-1", 42, 7, "starter");
  const b = seededPlayerGameweekPoints("seed-1", 42, 7, "starter");
  assert.equal(a, b);
});

test("seededPlayerGameweekPoints replays identically for the same seed across many draws", () => {
  const first = [];
  const second = [];
  for (let gw = 1; gw <= 38; gw++) {
    first.push(seededPlayerGameweekPoints("season-seed", 100, gw, "squad"));
  }
  for (let gw = 1; gw <= 38; gw++) {
    second.push(seededPlayerGameweekPoints("season-seed", 100, gw, "squad"));
  }
  assert.deepEqual(first, second);
});

test("seededPlayerGameweekPoints has real variance, not a flat average", () => {
  const values = new Set();
  for (let gw = 1; gw <= 38; gw++) {
    values.add(seededPlayerGameweekPoints("variance-seed", 200, gw, "starter"));
  }
  assert.ok(values.size > 5, "expected meaningfully varied gameweek scores");
});

test("seededPlayerGameweekPoints never returns a negative score", () => {
  for (let gw = 1; gw <= 100; gw++) {
    assert.ok(seededPlayerGameweekPoints("neg-check", gw, gw, "fringe") >= 0);
  }
});

function averagePoints(seed, tier, samples = 300) {
  let total = 0;
  for (let i = 0; i < samples; i++) {
    total += seededPlayerGameweekPoints(seed, 1000 + i, (i % 38) + 1, tier);
  }
  return total / samples;
}

test("tier weighting produces higher average scores for better tiers", () => {
  const starter = averagePoints("tier-seed", "starter");
  const squad = averagePoints("tier-seed", "squad");
  const unknown = averagePoints("tier-seed", "unknown");
  const fringe = averagePoints("tier-seed", "fringe");
  assert.ok(starter > squad, `starter (${starter}) should outscore squad (${squad}) on average`);
  assert.ok(squad > unknown, `squad (${squad}) should outscore unknown (${unknown}) on average`);
  assert.ok(unknown > fringe, `unknown (${unknown}) should outscore fringe (${fringe}) on average`);
});

test("an unrecognised or missing tier falls back to the unknown tier's distribution", () => {
  const missing = averagePoints("fallback-seed", undefined);
  const unknown = averagePoints("fallback-seed", "unknown");
  const bogus = averagePoints("fallback-seed", "goalkeeper-but-spelled-wrong");
  assert.equal(missing, unknown);
  assert.equal(bogus, unknown);
});

function averagePointsForPosition(seed, tier, position, samples = 500) {
  let total = 0;
  for (let i = 0; i < samples; i++) {
    total += seededPlayerGameweekPoints(seed, 5000 + i, (i % 38) + 1, tier, position);
  }
  return total / samples;
}

// The bug this guards against: seededPlayerGameweekPoints used to weight
// purely by tier, so a starter goalkeeper drew from the exact same
// distribution as a starter forward and could headline the report card as
// MVP. Position weighting must make that impossible on average.
test("a starter forward outscores a starter goalkeeper on average", () => {
  const forward = averagePointsForPosition("position-seed", "starter", "FWD");
  const goalkeeper = averagePointsForPosition("position-seed", "starter", "GK");
  assert.ok(
    forward > goalkeeper,
    `starter forward (${forward}) should outscore starter goalkeeper (${goalkeeper}) on average`,
  );
});

test("position weighting roughly follows FWD/MID above DEF above GK, same tier", () => {
  const forward = averagePointsForPosition("position-order-seed", "starter", "FWD");
  const midfielder = averagePointsForPosition("position-order-seed", "starter", "MID");
  const defender = averagePointsForPosition("position-order-seed", "starter", "DEF");
  const goalkeeper = averagePointsForPosition("position-order-seed", "starter", "GK");
  assert.ok(forward > defender, `forward (${forward}) should outscore defender (${defender})`);
  assert.ok(midfielder > defender, `midfielder (${midfielder}) should outscore defender (${defender})`);
  assert.ok(defender > goalkeeper, `defender (${defender}) should outscore goalkeeper (${goalkeeper})`);
});

test("an unrecognised or missing position falls back to a neutral multiplier", () => {
  // Same seed, tier, player-id range and sample count throughout, only the
  // position argument differs, so an exact match confirms both map to the
  // same (neutral, 1.0) multiplier rather than merely producing similar
  // numbers by coincidence.
  const missing = averagePointsForPosition("position-fallback-seed", "starter", undefined);
  const bogus = averagePointsForPosition("position-fallback-seed", "starter", "SWEEPER");
  assert.equal(missing, bogus);
});

// -- Season simulation ------------------------------------------------------------

function smallRosterFor(prefix) {
  // 2 GK, 5 DEF, 5 MID, 3 FWD, matching SQUAD_SLOTS exactly, ids namespaced
  // per manager so no two managers ever share a player id.
  const roster = [];
  let id = 1;
  const add = (position, count) => {
    for (let i = 0; i < count; i++) roster.push({ id: `${prefix}-${id++}`, name: `${prefix} ${position}${i}`, position, tier: "squad" });
  };
  add("GK", 2);
  add("DEF", 5);
  add("MID", 5);
  add("FWD", 3);
  return roster;
}

test("simulateDemoSeason keeps a manager's points-for equal to the sum of their own gameweek scores", () => {
  const { members } = createDemoMembers(4, "Tester");
  const rosters = new Map(members.map((member) => [member.userId, smallRosterFor(member.userId)]));
  const season = simulateDemoSeason({ seed: "consistency-seed", members, rosters, gameweeks: 10 });
  for (const member of members) {
    const row = season.standings.find((entry) => entry.userId === member.userId);
    const sum = season.gwPointsByUser.get(member.userId).reduce((total, points) => total + points, 0);
    assert.equal(row.pointsFor, sum, `${member.userId}'s pointsFor should equal the sum of their gameweek scores`);
  }
});

test("simulateDemoSeason is deterministic given the same seed", () => {
  const { members } = createDemoMembers(4, "Tester");
  const rosters = new Map(members.map((member) => [member.userId, smallRosterFor(member.userId)]));
  const first = simulateDemoSeason({ seed: "replay-seed", members, rosters, gameweeks: 12 });
  const second = simulateDemoSeason({ seed: "replay-seed", members, rosters, gameweeks: 12 });
  assert.deepEqual(
    first.fixtures.map((f) => [f.gameweek, f.homeUserId, f.awayUserId, f.homeScore, f.awayScore]),
    second.fixtures.map((f) => [f.gameweek, f.homeUserId, f.awayUserId, f.homeScore, f.awayScore]),
  );
  assert.deepEqual(first.standings, second.standings);
});

test("simulateDemoSeason produces the full round-robin fixture count for an even league", () => {
  const { members } = createDemoMembers(6, "Tester");
  const rosters = new Map(members.map((member) => [member.userId, smallRosterFor(member.userId)]));
  const season = simulateDemoSeason({ seed: "fixture-count-seed", members, rosters, gameweeks: 38 });
  assert.equal(season.fixtures.length, (38 * 6) / 2);
});

// -- Report card -----------------------------------------------------------------

const REPORT_MEMBERS = [
  { userId: "you", name: "Me" },
  { userId: "bot-1", name: "Rival A" },
  { userId: "bot-2", name: "Rival B" },
];

test("buildDemoReportCard picks the first-seen gameweek on a tie for best gameweek", () => {
  const season = {
    standings: [{ userId: "you", played: 4, wins: 1, draws: 1, losses: 2, pointsFor: 55, pointsAgainst: 60 }],
    fixtures: [],
    gwPointsByUser: new Map([["you", [10, 20, 20, 5]]]),
    playerSeasonTotals: new Map([["you", new Map()]]),
    lineups: new Map([["you", { starters: [] }]]),
    rosterById: new Map(),
  };
  const card = buildDemoReportCard({ humanId: "you", members: REPORT_MEMBERS, season });
  assert.deepEqual(card.bestGameweek, { gameweek: 2, points: 20 });
});

test("buildDemoReportCard picks the first starter in lineup order on an MVP/weak-link tie", () => {
  const season = {
    standings: [{ userId: "you", played: 2, wins: 1, draws: 0, losses: 1, pointsFor: 100, pointsAgainst: 90 }],
    fixtures: [],
    gwPointsByUser: new Map([["you", [50, 50]]]),
    playerSeasonTotals: new Map([
      [
        "you",
        new Map([
          [1, 50],
          [2, 50],
        ]),
      ],
    ]),
    lineups: new Map([
      [
        "you",
        {
          starters: [
            { playerId: 1, isCaptain: false },
            { playerId: 2, isCaptain: true },
          ],
        },
      ],
    ]),
    rosterById: new Map([
      [1, { id: 1, name: "Player A" }],
      [2, { id: 2, name: "Player B" }],
    ]),
  };
  const card = buildDemoReportCard({ humanId: "you", members: REPORT_MEMBERS, season });
  assert.equal(card.mvp.player.name, "Player A");
  assert.equal(card.weakLink.player.name, "Player A");
});

test("buildDemoReportCard finds a real MVP/weak-link split when scores differ", () => {
  const season = {
    standings: [{ userId: "you", played: 2, wins: 2, draws: 0, losses: 0, pointsFor: 130, pointsAgainst: 40 }],
    fixtures: [],
    gwPointsByUser: new Map([["you", [70, 60]]]),
    playerSeasonTotals: new Map([
      [
        "you",
        new Map([
          [1, 15],
          [2, 90],
        ]),
      ],
    ]),
    lineups: new Map([
      [
        "you",
        {
          starters: [
            { playerId: 1, isCaptain: false },
            { playerId: 2, isCaptain: true },
          ],
        },
      ],
    ]),
    rosterById: new Map([
      [1, { id: 1, name: "Bench Warmer" }],
      [2, { id: 2, name: "Star Striker" }],
    ]),
  };
  const card = buildDemoReportCard({ humanId: "you", members: REPORT_MEMBERS, season });
  assert.equal(card.mvp.player.name, "Star Striker");
  assert.equal(card.mvp.points, 90);
  assert.equal(card.weakLink.player.name, "Bench Warmer");
  assert.equal(card.weakLink.points, 15);
});

test("buildDemoReportCard names the rival who beat you most, first-encountered wins a tie", () => {
  const season = {
    standings: [{ userId: "you", played: 4, wins: 0, draws: 0, losses: 4, pointsFor: 40, pointsAgainst: 80 }],
    fixtures: [
      { gameweek: 1, homeUserId: "you", awayUserId: "bot-1", homeScore: 10, awayScore: 20 },
      { gameweek: 2, homeUserId: "bot-2", awayUserId: "you", homeScore: 20, awayScore: 10 },
      { gameweek: 3, homeUserId: "you", awayUserId: "bot-1", homeScore: 10, awayScore: 20 },
      { gameweek: 4, homeUserId: "bot-2", awayUserId: "you", homeScore: 20, awayScore: 10 },
    ],
    gwPointsByUser: new Map([["you", [10, 10, 10, 10]]]),
    playerSeasonTotals: new Map([["you", new Map()]]),
    lineups: new Map([["you", { starters: [] }]]),
    rosterById: new Map(),
  };
  const card = buildDemoReportCard({ humanId: "you", members: REPORT_MEMBERS, season });
  // bot-1 and bot-2 both beat "you" twice; bot-1 was encountered first.
  assert.equal(card.rival.name, "Rival A");
  assert.equal(card.rival.losses, 2);
});

test("buildDemoReportCard reports no rival for an undefeated season", () => {
  const season = {
    standings: [{ userId: "you", played: 2, wins: 2, draws: 0, losses: 0, pointsFor: 100, pointsAgainst: 50 }],
    fixtures: [
      { gameweek: 1, homeUserId: "you", awayUserId: "bot-1", homeScore: 30, awayScore: 10 },
      { gameweek: 2, homeUserId: "bot-2", awayUserId: "you", homeScore: 10, awayScore: 70 },
    ],
    gwPointsByUser: new Map([["you", [30, 70]]]),
    playerSeasonTotals: new Map([["you", new Map()]]),
    lineups: new Map([["you", { starters: [] }]]),
    rosterById: new Map(),
  };
  const card = buildDemoReportCard({ humanId: "you", members: REPORT_MEMBERS, season });
  assert.equal(card.rival, null);
});

// -- Share text --------------------------------------------------------------------

test("composeDemoShareText includes finish, points, MVP and the link, with no em/en dashes", () => {
  const reportCard = {
    position: 2,
    leagueSize: 6,
    pointsFor: 1842,
    pointsAgainst: 1601,
    mvp: { player: { name: "Erling Haaland" }, points: 240 },
  };
  const text = composeDemoShareText(reportCard, "https://kickoffdraft.com/#demo");
  assert.match(text, /2nd of 6/);
  assert.match(text, /1842/);
  assert.match(text, /1601/);
  assert.match(text, /Erling Haaland/);
  assert.match(text, /https:\/\/kickoffdraft\.com\/#demo/);
  assert.equal(/[–—]/.test(text), false, "share text must never contain an em or en dash");
});

test("composeDemoShareText omits the MVP clause gracefully when there is no MVP", () => {
  const reportCard = { position: 1, leagueSize: 4, pointsFor: 900, pointsAgainst: 700, mvp: null };
  const text = composeDemoShareText(reportCard, "https://kickoffdraft.com/#demo");
  assert.match(text, /1st of 4/);
  assert.equal(text.includes("MVP"), false);
});
