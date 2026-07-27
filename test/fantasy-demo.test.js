import assert from "node:assert/strict";
import test from "node:test";

import { SQUAD_SIZE, SQUAD_SLOTS } from "../src/fantasy.js";
import {
  advanceDemoSeasonChunk,
  applyDemoPick,
  autoBenchInjured,
  autoPickForRoom,
  availableWaiverPlayers,
  buildDemoReportCard,
  composeDemoShareText,
  createDemoMembers,
  DEFAULT_DEMO_CLOCK_SECONDS,
  DEFAULT_DEMO_MANAGER_NAME,
  demoChunkBoundaries,
  DEMO_CHUNK_COUNT,
  DEMO_CLOCK_SECONDS_OPTIONS,
  DEMO_CLOCK_UNTIMED,
  DEMO_HUMAN_ID,
  demoManagerForm,
  DEMO_SEASON_GAMEWEEKS,
  demoClockDurationMs,
  draftedPlayerIds,
  initDemoDraftRoom,
  initDemoSeason,
  isDemoDraftComplete,
  isDemoSeasonComplete,
  isFinalChunk,
  saveDemoLineup,
  seededPlayerGameweekPoints,
  simulateDemoSeasonToEnd,
  standingsThroughGameweek,
  submitDemoWaiverClaims,
} from "../src/fantasyDemo.js";
import { standingsFromFixtures } from "../src/fantasyGameweek.js";

// Runs the new stepwise engine to completion, the equivalent of the old
// one-shot simulateDemoSeason (removed - see CLAUDE.md/the task brief: "the
// old batch behaviour"), then attaches the final standings the same way
// app.js does once a season finishes, so buildDemoReportCard tests below can
// keep reading season.standings as a plain array.
function runFullSeason({ seed, members, rosters, gameweeks = DEMO_SEASON_GAMEWEEKS }) {
  let season = initDemoSeason({ seed, members, rosters, gameweeks });
  while (!isDemoSeasonComplete(season)) {
    season = advanceDemoSeasonChunk(season);
  }
  season.standings = standingsFromFixtures(season.fixtures, members);
  return season;
}

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

test("applyDemoPick tags a pick's viaQueue flag onto its picks entry, defaulting false when the caller omits it", () => {
  const pool = buildPool();
  const { members } = createDemoMembers(4, "Tester");
  const memberIds = members.map((member) => member.userId);
  let room = initDemoDraftRoom(memberIds);
  const [gk1, gk2] = pool.filter((candidate) => candidate.position === "GK");

  room = applyDemoPick(room, gk1, { viaQueue: true });
  room = applyDemoPick(room, gk2); // manual/bot pick: no second argument at all
  assert.equal(room.picks[0].viaQueue, true, "the queue-driven pick must be flagged");
  assert.equal(room.picks[1].viaQueue, false, "an ordinary pick must default to false, not undefined");
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

test("advanceDemoSeasonChunk keeps a manager's points-for equal to the sum of their own gameweek scores", () => {
  const { members } = createDemoMembers(4, "Tester");
  const rosters = new Map(members.map((member) => [member.userId, smallRosterFor(member.userId)]));
  const season = runFullSeason({ seed: "consistency-seed", members, rosters, gameweeks: 10 });
  for (const member of members) {
    const row = season.standings.find((entry) => entry.userId === member.userId);
    const sum = season.gwPointsByUser.get(member.userId).reduce((total, points) => total + points, 0);
    assert.equal(row.pointsFor, sum, `${member.userId}'s pointsFor should equal the sum of their gameweek scores`);
  }
});

test("advanceDemoSeasonChunk is deterministic given the same seed and no waiver activity", () => {
  const { members } = createDemoMembers(4, "Tester");
  const rosters = new Map(members.map((member) => [member.userId, smallRosterFor(member.userId)]));
  const first = runFullSeason({ seed: "replay-seed", members, rosters, gameweeks: 12 });
  const second = runFullSeason({ seed: "replay-seed", members, rosters, gameweeks: 12 });
  assert.deepEqual(
    first.fixtures.map((f) => [f.gameweek, f.homeUserId, f.awayUserId, f.homeScore, f.awayScore]),
    second.fixtures.map((f) => [f.gameweek, f.homeUserId, f.awayUserId, f.homeScore, f.awayScore]),
  );
  assert.deepEqual(first.standings, second.standings);
});

test("advanceDemoSeasonChunk produces the full round-robin fixture count for an even league", () => {
  const { members } = createDemoMembers(6, "Tester");
  const rosters = new Map(members.map((member) => [member.userId, smallRosterFor(member.userId)]));
  const season = runFullSeason({ seed: "fixture-count-seed", members, rosters, gameweeks: 38 });
  assert.equal(season.fixtures.length, (38 * 6) / 2);
});

test("initDemoSeason/advanceDemoSeasonChunk pauses at each chunk boundary rather than simulating all 38 gameweeks at once", () => {
  const { members } = createDemoMembers(4, "Tester");
  const rosters = new Map(members.map((member) => [member.userId, smallRosterFor(member.userId)]));
  let season = initDemoSeason({ seed: "chunked-seed", members, rosters });
  assert.equal(season.simulatedThrough, 0);
  season = advanceDemoSeasonChunk(season);
  assert.equal(season.simulatedThrough, 7, "the first of 6 chunks should stop after gameweek 7 (38/6, remainder-first)");
  assert.equal(isDemoSeasonComplete(season), false);
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

// -- Fixture-aware scoring, injuries, and form (season engine integration) -------

function teamedRoster(prefix, team) {
  return smallRosterFor(prefix).map((player) => ({ ...player, team }));
}

test("a club with no fixture that gameweek scores 0 for every one of its players (a blank gameweek)", () => {
  const { members } = createDemoMembers(4, "Tester");
  const rosters = new Map([
    [members[0].userId, teamedRoster(members[0].userId, "Alpha")],
    [members[1].userId, teamedRoster(members[1].userId, "Beta")],
    [members[2].userId, teamedRoster(members[2].userId, "Gamma")],
    [members[3].userId, teamedRoster(members[3].userId, "Delta")],
  ]);
  const matches = [
    { matchday: 1, homeTeam: "Alpha", awayTeam: "Beta" },
    { matchday: 1, homeTeam: "Gamma", awayTeam: "Delta" },
    // gameweek 2: only Gamma/Delta have a fixture - Alpha and Beta are blank.
    { matchday: 2, homeTeam: "Gamma", awayTeam: "Delta" },
  ];
  let season = initDemoSeason({ seed: "blank-seed", members, rosters, matches, gameweeks: 2, chunks: 1 });
  season = advanceDemoSeasonChunk(season);
  const alphaRoster = rosters.get(members[0].userId);
  const betaRoster = rosters.get(members[1].userId);
  for (const player of [...alphaRoster, ...betaRoster]) {
    assert.equal(
      season.playerPointsByGameweek.get(player.id)[1],
      0,
      `${player.id} (blank club) should score 0 in gameweek 2`,
    );
  }
  const gammaRoster = rosters.get(members[2].userId);
  const anyGammaScored = gammaRoster.some((player) => season.playerPointsByGameweek.get(player.id)[1] > 0);
  assert.ok(anyGammaScored, "sanity check: a club WITH a fixture that gameweek should not be forced to 0");
});

test("an injured player scores exactly 0 for every gameweek inside their injury window", () => {
  const { members } = createDemoMembers(4, "Tester");
  const rosters = new Map(members.map((member) => [member.userId, smallRosterFor(member.userId)]));
  let season = initDemoSeason({ seed: "injury-integration-seed", members, rosters, gameweeks: 38, chunks: 1 });
  season = advanceDemoSeasonChunk(season);
  let foundInjury = false;
  for (const [playerId, series] of season.playerPointsByGameweek.entries()) {
    for (const window of season.injuryWindows.get(playerId) ?? []) {
      foundInjury = true;
      for (let gw = window.start; gw <= window.end; gw++) {
        assert.equal(series[gw - 1], 0, `player ${playerId} should score 0 in gw ${gw} (injured ${window.start}-${window.end})`);
      }
    }
  }
  assert.ok(foundInjury, "expected at least one injury across a 60-player pool over 38 gameweeks");
});

test("fixture difficulty changes a player's total: facing a weak side all season outscores facing a strong side", () => {
  const { members } = createDemoMembers(2, "Tester");
  const roster = teamedRoster("mine", "MyClub");
  const rosters = new Map([
    [members[0].userId, roster],
    [members[1].userId, teamedRoster("theirs", "Filler")],
  ]);

  const weakOpponentTable = new Map([
    ["Top", { team: "Top", position: 1, played: 10 }],
    ["MyClub", { team: "MyClub", position: 2, played: 10 }],
    ["Mid", { team: "Mid", position: 3, played: 10 }],
    ["Weakling", { team: "Weakling", position: 4, played: 10 }],
  ]);
  const strongOpponentTable = new Map([
    ["Titan", { team: "Titan", position: 1, played: 10 }],
    ["MyClub", { team: "MyClub", position: 2, played: 10 }],
    ["Mid2", { team: "Mid2", position: 3, played: 10 }],
    ["Bottom", { team: "Bottom", position: 4, played: 10 }],
  ]);
  const matchesVsWeak = Array.from({ length: 38 }, (_, i) => ({ matchday: i + 1, homeTeam: "MyClub", awayTeam: "Weakling" }));
  const matchesVsStrong = Array.from({ length: 38 }, (_, i) => ({ matchday: i + 1, homeTeam: "MyClub", awayTeam: "Titan" }));

  let easySeason = initDemoSeason({ seed: "difficulty-seed", members, rosters, matches: matchesVsWeak, standingsMap: weakOpponentTable, chunks: 1 });
  let hardSeason = initDemoSeason({ seed: "difficulty-seed", members, rosters, matches: matchesVsStrong, standingsMap: strongOpponentTable, chunks: 1 });
  easySeason = advanceDemoSeasonChunk(easySeason);
  hardSeason = advanceDemoSeasonChunk(hardSeason);

  const totalEasy = roster.reduce((sum, player) => sum + (easySeason.seasonPointsByPlayer.get(player.id) ?? 0), 0);
  const totalHard = roster.reduce((sum, player) => sum + (hardSeason.seasonPointsByPlayer.get(player.id) ?? 0), 0);
  assert.ok(totalEasy > totalHard, `facing a weak side all season (${totalEasy}) should outscore facing a strong side (${totalHard})`);
});

// -- Waivers at the desk ------------------------------------------------------------

test("submitDemoWaiverClaims: the human wins a contested wire player when their rolling priority is better", () => {
  const { members } = createDemoMembers(3, "Tester"); // you (priority 1), bot-1, bot-2
  const rosters = new Map(members.map((member) => [member.userId, smallRosterFor(member.userId)]));
  let season = initDemoSeason({ seed: "waiver-seed", members, rosters, gameweeks: 7, chunks: 1 });
  season = advanceDemoSeasonChunk(season);

  const freeAgent = { id: "wire-def-1", name: "Wire DEF", position: "DEF", tier: "starter" };
  season.rosterById.set(freeAgent.id, freeAgent);
  season.seasonPointsByPlayer.set(freeAgent.id, 999); // an irresistible upgrade for anyone's weakest DEF

  const myWorstDef = rosters.get("you").find((player) => player.position === "DEF");
  const humanClaim = { addPlayerId: freeAgent.id, dropPlayerId: myWorstDef.id };

  const { season: resolved, humanResult } = submitDemoWaiverClaims(season, { humanId: "you", humanClaim });
  assert.equal(humanResult.status, "processed", "priority 1 should win a contested claim over lower-priority bots");
  const humanRosterAfter = resolved.rosters.get("you");
  assert.equal(humanRosterAfter.length, SQUAD_SIZE);
  assert.ok(humanRosterAfter.some((player) => player.id === freeAgent.id));
  assert.equal(humanRosterAfter.some((player) => player.id === myWorstDef.id), false);
  const counts = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const player of humanRosterAfter) counts[player.position] += 1;
  assert.deepEqual(counts, SQUAD_SLOTS, "the same-position-swap invariant must hold after a waiver win");
});

test("submitDemoWaiverClaims: a bot with better rolling priority wins the same contested wire player instead", () => {
  const { members } = createDemoMembers(3, "Tester");
  const rosters = new Map(members.map((member) => [member.userId, smallRosterFor(member.userId)]));
  let season = initDemoSeason({ seed: "waiver-seed-2", members, rosters, gameweeks: 7, chunks: 1 });
  season = advanceDemoSeasonChunk(season);
  season.priorities = [
    { userId: "bot-1", priority: 1 },
    { userId: "bot-2", priority: 2 },
    { userId: "you", priority: 3 },
  ];

  const freeAgent = { id: "wire-def-2", name: "Wire DEF 2", position: "DEF", tier: "starter" };
  season.rosterById.set(freeAgent.id, freeAgent);
  season.seasonPointsByPlayer.set(freeAgent.id, 999);
  const myWorstDef = rosters.get("you").find((player) => player.position === "DEF");
  const humanClaim = { addPlayerId: freeAgent.id, dropPlayerId: myWorstDef.id };

  const { season: resolved, humanResult } = submitDemoWaiverClaims(season, { humanId: "you", humanClaim });
  assert.equal(humanResult.status, "rejected");
  assert.equal(humanResult.reason, "Player already claimed");
  const humanRosterAfter = resolved.rosters.get("you");
  assert.ok(humanRosterAfter.some((player) => player.id === myWorstDef.id), "a rejected claim must not drop the player after all");
});

test("submitDemoWaiverClaims lets bots act even when the human makes no claim at all", () => {
  const { members } = createDemoMembers(3, "Tester");
  const rosters = new Map(members.map((member) => [member.userId, smallRosterFor(member.userId)]));
  let season = initDemoSeason({ seed: "waiver-seed-3", members, rosters, gameweeks: 7, chunks: 1 });
  season = advanceDemoSeasonChunk(season);
  const freeAgent = { id: "wire-def-3", name: "Wire DEF 3", position: "DEF", tier: "starter" };
  season.rosterById.set(freeAgent.id, freeAgent);
  season.seasonPointsByPlayer.set(freeAgent.id, 999);

  const { season: resolved, humanResult } = submitDemoWaiverClaims(season, { humanId: "you", humanClaim: null });
  assert.equal(humanResult, null);
  assert.notEqual(resolved.ownedBy.get(freeAgent.id), undefined);
  assert.notEqual(resolved.ownedBy.get(freeAgent.id), "you");
});

test("submitDemoWaiverClaims is a no-op that returns the SAME season when nobody makes a claim", () => {
  const { members } = createDemoMembers(2, "Tester"); // no bots to auto-claim
  const rosters = new Map(members.map((member) => [member.userId, smallRosterFor(member.userId)]));
  const season = initDemoSeason({ seed: "waiver-noop-seed", members, rosters, gameweeks: 3, chunks: 1 });
  const { season: resolved, humanResult } = submitDemoWaiverClaims(season, { humanId: "you", humanClaim: null });
  assert.equal(resolved, season);
  assert.equal(humanResult, null);
});

test("availableWaiverPlayers ranks the unowned pool by season-to-date points, not preseason tier", () => {
  const { members } = createDemoMembers(2, "Tester");
  const rosters = new Map(members.map((member) => [member.userId, smallRosterFor(member.userId)]));
  const season = initDemoSeason({ seed: "wire-rank-seed", members, rosters, gameweeks: 3, chunks: 1 });
  season.rosterById.set("hidden-gem", { id: "hidden-gem", name: "Hidden Gem", position: "FWD", tier: "fringe" });
  season.rosterById.set("bust", { id: "bust", name: "Bust", position: "FWD", tier: "starter" });
  season.seasonPointsByPlayer.set("hidden-gem", 80);
  season.seasonPointsByPlayer.set("bust", 5);
  const ranked = availableWaiverPlayers(season).filter((player) => ["hidden-gem", "bust"].includes(player.id));
  assert.deepEqual(ranked.map((player) => player.id), ["hidden-gem", "bust"]);
});

// -- Lineup edits at the desk --------------------------------------------------------

test("saveDemoLineup rejects an illegal formation via the REAL validateLineupSelection, leaving the season untouched", () => {
  const { members } = createDemoMembers(2, "Tester");
  const roster = smallRosterFor("you");
  const rosters = new Map([
    [members[0].userId, roster],
    [members[1].userId, smallRosterFor("bot-1")],
  ]);
  const season = initDemoSeason({ seed: "lineup-seed", members, rosters, gameweeks: 5, chunks: 1 });
  const tooFewStarters = roster.slice(0, 5).map((player) => player.id);
  const result = saveDemoLineup(season, "you", { starters: tooFewStarters, captainId: tooFewStarters[0] });
  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.equal(result.season, season, "a rejected save must return the SAME season reference, not a mutated copy");
});

test("saveDemoLineup applies a legal captain change", () => {
  const { members } = createDemoMembers(2, "Tester");
  const roster = smallRosterFor("you");
  const rosters = new Map([
    [members[0].userId, roster],
    [members[1].userId, smallRosterFor("bot-1")],
  ]);
  const season = initDemoSeason({ seed: "lineup-seed-2", members, rosters, gameweeks: 5, chunks: 1 });
  const starters = season.lineups.get("you").starters.map((entry) => entry.playerId);
  const newCaptain = starters[1];
  const result = saveDemoLineup(season, "you", { starters, captainId: newCaptain });
  assert.equal(result.ok, true);
  const captainEntry = result.season.lineups.get("you").starters.find((entry) => entry.isCaptain);
  assert.equal(captainEntry.playerId, newCaptain);
});

test("autoBenchInjured swaps an injured starter for the best same-position bench option by season-to-date points", () => {
  const { members } = createDemoMembers(2, "Tester");
  const roster = smallRosterFor("you");
  const rosters = new Map([
    [members[0].userId, roster],
    [members[1].userId, smallRosterFor("bot-1")],
  ]);
  const season = initDemoSeason({ seed: "bench-seed", members, rosters, gameweeks: 5, chunks: 1 });

  const lineup = season.lineups.get("you");
  const starterId = lineup.starters[0].playerId;
  const starterPlayer = roster.find((player) => player.id === starterId);
  const benchOption = roster.find(
    (player) => player.position === starterPlayer.position && !lineup.starters.some((entry) => entry.playerId === player.id),
  );
  assert.ok(benchOption, "test fixture assumption: a bench player shares the first starter's position");

  season.injuryWindows.set(starterId, [{ start: 1, end: 3 }]);
  season.seasonPointsByPlayer.set(benchOption.id, 500);

  const next = autoBenchInjured(season, "you", 2);
  const newStarterIds = next.lineups.get("you").starters.map((entry) => entry.playerId);
  assert.equal(newStarterIds.includes(starterId), false);
  assert.equal(newStarterIds.includes(benchOption.id), true);
});

test("autoBenchInjured is a no-op when nobody in the lineup is currently injured", () => {
  const { members } = createDemoMembers(2, "Tester");
  const rosters = new Map(members.map((member) => [member.userId, smallRosterFor(member.userId)]));
  const season = initDemoSeason({ seed: "bench-noop-seed", members, rosters, gameweeks: 5, chunks: 1 });
  assert.equal(autoBenchInjured(season, "you", 1), season);
});

// -- Watch or manage: the "sim to the end" escape ------------------------------------

test("simulateDemoSeasonToEnd reaches the final gameweek without needing any further desk decisions", () => {
  const { members } = createDemoMembers(4, "Tester");
  const rosters = new Map(members.map((member) => [member.userId, smallRosterFor(member.userId)]));
  let season = initDemoSeason({ seed: "sim-to-end-seed", members, rosters });
  season = advanceDemoSeasonChunk(season);
  const finished = simulateDemoSeasonToEnd(season, { humanId: "you" });
  assert.equal(isDemoSeasonComplete(finished), true);
  assert.equal(finished.simulatedThrough, DEMO_SEASON_GAMEWEEKS);
});

test("simulateDemoSeasonToEnd never breaks the human's squad-slot invariant despite auto-managed waiver activity", () => {
  const { members } = createDemoMembers(6, "Tester");
  const rosters = new Map(members.map((member) => [member.userId, smallRosterFor(member.userId)]));
  const season = initDemoSeason({ seed: "sim-to-end-invariant-seed", members, rosters });
  const finished = simulateDemoSeasonToEnd(season, { humanId: "you" });
  const roster = finished.rosters.get("you");
  assert.equal(roster.length, SQUAD_SIZE);
  const counts = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const player of roster) counts[player.position] += 1;
  assert.deepEqual(counts, SQUAD_SLOTS);
});

// -- Chunking and form helpers --------------------------------------------------------

test("demoChunkBoundaries splits 38 gameweeks into 6 chunks, remainder spread across the first chunks", () => {
  assert.deepEqual(demoChunkBoundaries(38, 6), [7, 14, 20, 26, 32, 38]);
});

test("DEMO_CHUNK_COUNT is 6, matching the 'roughly 6 decisions' pacing from the brief", () => {
  assert.equal(DEMO_CHUNK_COUNT, 6);
});

test("isFinalChunk is only true once every chunk boundary has been played", () => {
  const { members } = createDemoMembers(2, "Tester");
  const rosters = new Map(members.map((member) => [member.userId, smallRosterFor(member.userId)]));
  let season = initDemoSeason({ seed: "final-chunk-seed", members, rosters, gameweeks: 4, chunks: 2 });
  assert.equal(isFinalChunk(season), false);
  season = advanceDemoSeasonChunk(season);
  assert.equal(isFinalChunk(season), false);
  season = advanceDemoSeasonChunk(season);
  assert.equal(isFinalChunk(season), true);
});

test("demoManagerForm reports W/D/L oldest-first for a manager's own decided fixtures only", () => {
  const fixtures = [
    { gameweek: 1, homeUserId: "you", awayUserId: "bot-1", homeScore: 50, awayScore: 40 },
    { gameweek: 2, homeUserId: "bot-2", awayUserId: "you", homeScore: 60, awayScore: 60 },
    { gameweek: 3, homeUserId: "you", awayUserId: "bot-1", homeScore: 30, awayScore: 45 },
  ];
  assert.deepEqual(demoManagerForm(fixtures, "you", 3), ["W", "D", "L"]);
});

test("demoManagerForm caps to the last N results", () => {
  const fixtures = Array.from({ length: 7 }, (_, i) => ({
    gameweek: i + 1,
    homeUserId: "you",
    awayUserId: "bot-1",
    homeScore: 10,
    awayScore: 0,
  }));
  assert.equal(demoManagerForm(fixtures, "you", 7, 5).length, 5);
});

// -- Report card: bestTransfer / worstInjuryLuck --------------------------------------

test("buildDemoReportCard surfaces the best transfer: the acquired player's points scored SINCE acquisition", () => {
  const season = {
    standings: [{ userId: "you", played: 2, wins: 1, draws: 0, losses: 1, pointsFor: 100, pointsAgainst: 90 }],
    fixtures: [],
    gwPointsByUser: new Map([["you", [50, 50]]]),
    playerSeasonTotals: new Map([["you", new Map()]]),
    lineups: new Map([["you", { starters: [] }]]),
    rosterById: new Map([
      [1, { id: 1, name: "Waiver Wonder" }],
      [2, { id: 2, name: "Dropped Dud" }],
    ]),
    waiverLog: [
      { userId: "you", status: "processed", addPlayerId: 1, dropPlayerId: 2, gameweek: 1 },
      { userId: "bot-1", status: "processed", addPlayerId: 3, dropPlayerId: 4, gameweek: 1 },
    ],
    playerPointsByGameweek: new Map([[1, [0, 20, 15]]]),
  };
  const card = buildDemoReportCard({ humanId: "you", members: REPORT_MEMBERS, season });
  assert.equal(card.bestTransfer.player.name, "Waiver Wonder");
  assert.equal(card.bestTransfer.points, 35);
});

test("buildDemoReportCard surfaces the worst injury luck among the human's CURRENT roster", () => {
  const season = {
    standings: [{ userId: "you", played: 1, wins: 1, draws: 0, losses: 0, pointsFor: 50, pointsAgainst: 10 }],
    fixtures: [],
    gwPointsByUser: new Map([["you", [50]]]),
    playerSeasonTotals: new Map([["you", new Map()]]),
    lineups: new Map([["you", { starters: [] }]]),
    rosterById: new Map(),
    rosters: new Map([
      [
        "you",
        [
          { id: 1, name: "Fit" },
          { id: 2, name: "Crocked" },
        ],
      ],
    ]),
    injuryWindows: new Map([
      [1, [{ start: 1, end: 1 }]],
      [2, [{ start: 2, end: 5 }]],
    ]),
  };
  const card = buildDemoReportCard({ humanId: "you", members: REPORT_MEMBERS, season });
  assert.equal(card.worstInjuryLuck.player.name, "Crocked");
  assert.equal(card.worstInjuryLuck.gameweeksMissed, 4);
});

test("buildDemoReportCard's bestTransfer/worstInjuryLuck are null (not throwing) against a minimal hand-built season", () => {
  const season = {
    standings: [{ userId: "you", played: 0, wins: 0, draws: 0, losses: 0, pointsFor: 0, pointsAgainst: 0 }],
    fixtures: [],
    gwPointsByUser: new Map([["you", []]]),
    playerSeasonTotals: new Map([["you", new Map()]]),
    lineups: new Map([["you", { starters: [] }]]),
    rosterById: new Map(),
  };
  const card = buildDemoReportCard({ humanId: "you", members: REPORT_MEMBERS, season });
  assert.equal(card.bestTransfer, null);
  assert.equal(card.worstInjuryLuck, null);
});
