import assert from "node:assert/strict";
import test from "node:test";

import {
  GRADE_SCALE_FLOOR,
  bestStartingXi,
  buildDraftRecap,
  composeDraftShareText,
  gradeFromZ,
  managerEngagement,
  pickDelta,
  positionStartingPoints,
  positionVerdict,
} from "../src/fantasyDraftRecap.js";
import { STARTING_LIMITS, STARTING_SIZE } from "../src/fantasy.js";
import { PICK_VIA } from "../src/draftLogic.js";
import { rankDraftPool } from "../src/fantasyDraftRank.js";

// A pool big enough for a real board: replacement level is the
// (leagueSize * slots)-th best at each position, so the pool has to be
// comfortably deeper than the league consumes or every grade collapses.
function makePool({ perPosition = 30 } = {}) {
  const players = [];
  let id = 1;
  for (const [position, count] of Object.entries({ GK: perPosition, DEF: perPosition, MID: perPosition, FWD: perPosition })) {
    for (let i = 0; i < count; i += 1) {
      players.push({
        id: id++,
        name: `${position}${i + 1}`,
        team: `Club ${i % 20}`,
        position,
        // Descending within a position, so index order is quality order and a
        // test can reason about who the "best available" was.
        xp: 100 - i * 2,
      });
    }
  }
  return players;
}

// Deals a snake draft strictly in board order, which is the baseline every
// grade is measured against: nobody reaches, nobody steals.
function dealInBoardOrder(managers, players) {
  const board = rankDraftPool(players, managers.length);
  const picks = [];
  const size = managers.length;
  const rounds = Math.floor(board.length / size);
  let overall = 1;
  for (let round = 1; round <= Math.min(rounds, 15); round += 1) {
    const order = round % 2 === 0 ? [...managers].reverse() : managers;
    order.forEach((manager, index) => {
      picks.push({
        round,
        pickInRound: index + 1,
        overallPick: overall,
        userId: manager.userId,
        playerId: board[overall - 1].id,
        via: PICK_VIA.MANUAL,
      });
      overall += 1;
    });
  }
  return picks;
}

const MANAGERS = [
  { userId: 1, name: "Ada", isBot: false },
  { userId: 2, name: "Bo", isBot: false },
  { userId: 3, name: "Cy", isBot: false },
  { userId: 4, name: "Bot Alfie", isBot: true },
];

test("gradeFromZ bands the curve and never throws on an unmeasurable score", () => {
  assert.equal(gradeFromZ(2), "A");
  assert.equal(gradeFromZ(1), "A");
  assert.equal(gradeFromZ(0.5), "B");
  assert.equal(gradeFromZ(0), "C");
  assert.equal(gradeFromZ(-0.5), "D");
  assert.equal(gradeFromZ(-2), "F");
  // An unmeasurable spread must read as "no information", never as a failure.
  assert.equal(gradeFromZ(NaN), "C");
  assert.equal(gradeFromZ(Infinity), "C");
});

test("pickDelta is positive for value and negative for a reach, and null off the board", () => {
  assert.equal(pickDelta(20, 5), 15, "getting the 5th ranked player at pick 20 is value");
  assert.equal(pickDelta(5, 20), -15, "spending pick 5 on the 20th ranked player is a reach");
  assert.equal(pickDelta(10, 10), 0, "a pick exactly on the board is neither");
  assert.equal(pickDelta(5, null), null, "a player with no board rank cannot have reached");
  assert.equal(pickDelta(null, 5), null);
});

test("bestStartingXi fields a legal XI and takes the best players available", () => {
  const roster = [
    ...Array.from({ length: 2 }, (_, i) => ({ id: 100 + i, position: "GK", xp: 10 - i })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: 200 + i, position: "DEF", xp: 50 - i })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: 300 + i, position: "MID", xp: 40 - i })),
    ...Array.from({ length: 3 }, (_, i) => ({ id: 400 + i, position: "FWD", xp: 30 - i })),
  ];
  const { players, points } = bestStartingXi(roster);

  assert.equal(players.length, STARTING_SIZE);
  const counts = {};
  for (const player of players) counts[player.position] = (counts[player.position] ?? 0) + 1;
  for (const [position, limit] of Object.entries(STARTING_LIMITS)) {
    assert.ok(counts[position] >= limit.min, `${position} below its minimum`);
    assert.ok(counts[position] <= limit.max, `${position} above its maximum`);
  }
  // The worst player in a bucket must never displace a better one from the
  // same bucket, which is the whole reason the roster is sorted by xP first.
  assert.equal(players.some((player) => player.id === 200), true, "the best defender was left out");
  assert.ok(points > 0);
});

test("positionStartingPoints counts only the players a manager must start", () => {
  const roster = [
    { id: 1, position: "MID", xp: 50 },
    { id: 2, position: "MID", xp: 40 },
    { id: 3, position: "MID", xp: 30 },
    { id: 4, position: "MID", xp: 20 },
  ];
  // MID's minimum is 2, so depth beyond it is bench cover and must not count:
  // five good midfielders should never paper over having no goalkeeper.
  assert.equal(positionStartingPoints(roster, "MID"), 90);
  assert.equal(positionStartingPoints(roster, "GK"), 0);
});

test("positionVerdict is relative to the league and refuses to judge a zero median", () => {
  assert.equal(positionVerdict(120, 100), "strength");
  assert.equal(positionVerdict(100, 100), "solid");
  assert.equal(positionVerdict(80, 100), "hole");
  // Nobody drafted this position anywhere: that is a different market, not a
  // league-wide hole.
  assert.equal(positionVerdict(0, 0), "solid");
  assert.equal(positionVerdict(5, null), "solid");
});

test("managerEngagement reports a bot as not applicable rather than as an absentee", () => {
  const picks = Array.from({ length: 15 }, () => ({ via: PICK_VIA.BOT }));
  assert.equal(managerEngagement(picks, true), null, "a bot must never be given an engagement rate");
});

test("managerEngagement separates being present from having a shortlist", () => {
  const picks = [
    { via: PICK_VIA.MANUAL },
    { via: PICK_VIA.MANUAL },
    { via: PICK_VIA.QUEUE },
    { via: PICK_VIA.AUTOPICK },
  ];
  assert.deepEqual(managerEngagement(picks, false), {
    picks: 4,
    manual: 2,
    queue: 1,
    autopick: 1,
    engagedPct: 75,
  });
});

test("managerEngagement is null when the picks predate the via column", () => {
  // Unmeasured, not absent. A zero here would be a fabricated accusation
  // against a manager whose draft simply happened before the column existed.
  assert.equal(managerEngagement([{ via: null }, { via: null }], false), null);
});

test("a draft dealt strictly in board order grades everyone the same", () => {
  // The baseline that proves the grade measures skill rather than draft slot:
  // if picking first were an advantage the grade did not neutralise, manager 1
  // would out-grade manager 4 here without having done anything.
  const players = makePool();
  const picks = dealInBoardOrder(MANAGERS, players);
  const recap = buildDraftRecap({ managers: MANAGERS, picks, players });

  assert.equal(recap.teams.length, 4);
  const grades = new Set(recap.teams.map((team) => team.grade));
  assert.equal(grades.size, 1, `slot luck leaked into the grades: ${[...grades].join(", ")}`);
  for (const team of recap.teams) {
    assert.equal(team.valueOverSlots, 0, `${team.name} deviated from a board-order draft`);
  }
});

test("a manager who steals value out-grades one who reaches", () => {
  const players = makePool();
  const picks = dealInBoardOrder(MANAGERS, players);
  const board = rankDraftPool(players, MANAGERS.length);

  // Manager 1 swaps their first pick for a player ranked far down the board:
  // a real reach, and the deepest one in the league.
  const reachTarget = board[100];
  const victim = picks.find((pick) => pick.userId === 1);
  const displaced = victim.playerId;
  victim.playerId = reachTarget.id;
  // The player they passed on falls to manager 3's last pick, which is the
  // corresponding steal.
  const beneficiary = [...picks].reverse().find((pick) => pick.userId === 3);
  beneficiary.playerId = displaced;

  const recap = buildDraftRecap({ managers: MANAGERS, picks, players });
  const reacher = recap.teams.find((team) => team.userId === 1);
  const stealer = recap.teams.find((team) => team.userId === 3);

  assert.ok(
    stealer.valueOverSlots > reacher.valueOverSlots,
    "reaching a hundred slots cost nothing against the board",
  );
  assert.ok("ABCDF".indexOf(stealer.grade) < "ABCDF".indexOf(reacher.grade), "the reach outgraded the steal");
  assert.equal(reacher.biggestReach.playerId, reachTarget.id);
  assert.ok(reacher.biggestReach.slots < 0, "a reach must report negative slots");
  assert.equal(stealer.bestValue.playerId, displaced);
  assert.ok(stealer.bestValue.slots > 0, "a steal must report positive slots");
});

test("an evenly drafted league does not manufacture an A and an F", () => {
  // Without GRADE_SCALE_FLOOR a two-manager league's z-scores are always
  // exactly +1 and -1, so a draft decided by a rounding error would hand out
  // the best and worst grades available.
  const players = makePool();
  const two = [
    { userId: 1, name: "Ada", isBot: false },
    { userId: 2, name: "Bo", isBot: false },
  ];
  const picks = dealInBoardOrder(two, players);
  const recap = buildDraftRecap({ managers: two, picks, players });

  assert.deepEqual(
    recap.teams.map((team) => team.grade),
    ["C", "C"],
  );
  assert.ok(GRADE_SCALE_FLOOR > 0);
});

test("every team gets a projected finish, and the ranking matches projected points", () => {
  const players = makePool();
  const picks = dealInBoardOrder(MANAGERS, players);
  const recap = buildDraftRecap({ managers: MANAGERS, picks, players });

  const finishes = recap.teams.map((team) => team.projectedFinish);
  assert.deepEqual([...finishes].sort((a, b) => a - b), [1, 2, 3, 4], "finishes must be a dense 1..N");
  // The payload is pre-sorted so a renderer never has to re-derive the order.
  assert.deepEqual(finishes, [1, 2, 3, 4]);
  for (let i = 1; i < recap.teams.length; i += 1) {
    assert.ok(
      recap.teams[i - 1].projectedPoints >= recap.teams[i].projectedPoints,
      "a lower projected finish had more projected points",
    );
  }
});

test("every position is reported for every team, with a verdict against the league median", () => {
  const players = makePool();
  const picks = dealInBoardOrder(MANAGERS, players);
  const recap = buildDraftRecap({ managers: MANAGERS, picks, players });

  for (const team of recap.teams) {
    assert.deepEqual(
      team.positions.map((entry) => entry.position),
      Object.keys(STARTING_LIMITS),
    );
    for (const entry of team.positions) {
      assert.equal(entry.startersRequired, STARTING_LIMITS[entry.position].min);
      assert.ok(["strength", "solid", "hole"].includes(entry.verdict));
    }
  }
});

test("a bot's squad is graded like anyone else's but is never given an engagement rate", () => {
  // Bots stay IN the numbers because their results count the same, exactly as
  // the weekly recap does. What they must not get is a statement about whether
  // a person turned up.
  const players = makePool();
  const picks = dealInBoardOrder(MANAGERS, players).map((pick) =>
    pick.userId === 4 ? { ...pick, via: PICK_VIA.BOT } : pick,
  );
  const recap = buildDraftRecap({ managers: MANAGERS, picks, players });

  const bot = recap.teams.find((team) => team.userId === 4);
  assert.equal(bot.isBot, true);
  assert.ok(bot.grade, "a bot's squad was not graded");
  assert.ok(bot.projectedFinish >= 1);
  assert.equal(bot.engagement, null);
  const human = recap.teams.find((team) => team.userId === 1);
  assert.ok(human.engagement, "a human's engagement was dropped");
});

test("a league too small to grade against returns no teams rather than nonsense", () => {
  const players = makePool();
  assert.deepEqual(buildDraftRecap({ managers: [], picks: [], players }), { leagueSize: 0, teams: [] });
  assert.deepEqual(buildDraftRecap({ managers: [MANAGERS[0]], picks: [], players }), {
    leagueSize: 1,
    teams: [],
  });
});

test("buildDraftRecap tolerates a pool with no expected points at all", () => {
  // xP is blended by a cron pass that may simply not have run yet on a fresh
  // season. That must produce a flat, uninformative recap, not a crash.
  const players = makePool().map((player) => ({ ...player, xp: null }));
  const picks = dealInBoardOrder(MANAGERS, players);
  const recap = buildDraftRecap({ managers: MANAGERS, picks, players });

  assert.equal(recap.teams.length, 4);
  for (const team of recap.teams) {
    assert.equal(team.grade, "C");
    assert.equal(team.projectedPoints, 0);
  }
});

test("the share text carries the numbers and never the league's invite code", () => {
  const players = makePool();
  const picks = dealInBoardOrder(MANAGERS, players);
  const recap = buildDraftRecap({ managers: MANAGERS, picks, players });
  const text = composeDraftShareText(recap.teams[0], recap.leagueSize, "https://kickoffdraft.com");

  assert.match(text, /Graded [ABCDF]/);
  assert.match(text, /1 of 4/);
  assert.match(text, /https:\/\/kickoffdraft\.com/);
  // Shared OUTWARDS: a link that silently joins the sender's private league is
  // not a thing to hand to a group chat.
  assert.equal(/invite/i.test(text), false);
  assert.equal(composeDraftShareText(null, 4, "x"), "");
});
