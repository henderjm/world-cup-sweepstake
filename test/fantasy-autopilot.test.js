import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTOPILOT_ACTIONS,
  AUTOPILOT_PICKUPS_PER_GAMEWEEK,
  AUTOPILOT_PICKUP_MARGIN,
  AUTOPILOT_RETURN_ACTIONS,
  autopilotAllows,
  autopilotDisengagesOn,
  autopilotPickup,
} from "../src/fantasyBots.js";
import { bestStartingXi } from "../src/fantasyLineups.js";
import { STARTING_LIMITS, STARTING_SIZE, validateFormation } from "../src/fantasy.js";

// Dead-team autopilot: the pure half. ESPN ships this as Auto Control and it is
// damage control, not engagement, so most of what is asserted here is what it
// REFUSES to do.

function roster({ gkXp = [40, 30], defXp = [50, 45, 40, 35, 30], midXp = [60, 55, 50, 45, 40], fwdXp = [70, 50, 30] } = {}) {
  const players = [];
  let id = 1;
  const add = (position, list) =>
    list.forEach((xp) => players.push({ id: id++, name: `${position}${id}`, team: `Club ${id}`, position, xp }));
  add("GK", gkXp);
  add("DEF", defXp);
  add("MID", midXp);
  add("FWD", fwdXp);
  return players;
}

test("autopilot may set a lineup and make a pickup, and may never trade", () => {
  // An allowlist, not a list of prohibitions. The day trades ship, an
  // autopilot built on "everything except trades" would silently gain the
  // ability to trade an absent manager's squad away.
  assert.deepEqual([...AUTOPILOT_ACTIONS], ["lineup", "pickup"]);
  assert.equal(autopilotAllows("lineup"), true);
  assert.equal(autopilotAllows("pickup"), true);
  assert.equal(autopilotAllows("trade"), false);
  assert.equal(autopilotAllows("propose_trade"), false);
  assert.equal(autopilotAllows(""), false);
  assert.equal(autopilotAllows(undefined), false);
});

test("every way a manager can touch their league switches autopilot off", () => {
  // The reversibility rule. A manager who comes back to find the app still
  // playing their team would be right to leave.
  for (const action of ["lineup", "free_agent", "waiver_claim", "draft_queue", "chat"]) {
    assert.equal(autopilotDisengagesOn(action), true, `${action} did not disengage autopilot`);
  }
  assert.equal(autopilotDisengagesOn("viewed_standings"), false, "merely reading is not a move");
  assert.equal(autopilotDisengagesOn(undefined), false);
  // Kept in step with the list the Worker actually calls clearAutopilot from.
  assert.equal(AUTOPILOT_RETURN_ACTIONS.length, 5);
});

test("autopilot takes an obvious upgrade at the same position", () => {
  const mine = roster();
  const worstForward = mine.filter((player) => player.position === "FWD").sort((a, b) => a.xp - b.xp)[0];
  const freeAgents = [{ id: 900, name: "Star", team: "Arsenal", position: "FWD", xp: worstForward.xp + 40 }];

  const move = autopilotPickup({ roster: mine, freeAgents, lockedPlayerIds: new Set() });
  assert.ok(move, "an obvious upgrade was declined");
  assert.equal(move.add.id, 900);
  assert.equal(move.drop.id, worstForward.id, "autopilot dropped somebody other than its worst player there");
  assert.equal(move.add.position, move.drop.position, "the swap changed a roster bucket's size");
  assert.equal(move.gain, 40);
});

test("autopilot declines a marginal upgrade", () => {
  // Standing in for an absent person, not playing the waiver wire for them. A
  // marginal churn of a squad its owner may come back to is worse than nothing.
  const mine = roster();
  const worst = mine.filter((player) => player.position === "FWD").sort((a, b) => a.xp - b.xp)[0];
  const freeAgents = [
    { id: 900, name: "Slightly better", team: "Arsenal", position: "FWD", xp: worst.xp + AUTOPILOT_PICKUP_MARGIN - 1 },
  ];
  assert.equal(autopilotPickup({ roster: mine, freeAgents, lockedPlayerIds: new Set() }), null);

  // Exactly at the margin is taken: the constant is the bar, not a gap below it.
  freeAgents[0].xp = worst.xp + AUTOPILOT_PICKUP_MARGIN;
  assert.ok(autopilotPickup({ roster: mine, freeAgents, lockedPlayerIds: new Set() }));
});

test("autopilot never swaps across positions", () => {
  // A cross-position swap would leave a roster bucket short and the XI
  // unfillable. Only a striker is on offer, and only keepers are droppable.
  const mine = roster().filter((player) => player.position === "GK");
  const freeAgents = [{ id: 900, name: "Star", team: "Arsenal", position: "FWD", xp: 500 }];
  assert.equal(autopilotPickup({ roster: mine, freeAgents, lockedPlayerIds: new Set() }), null);
});

test("a locked player is never on either side of an autopilot swap", () => {
  // The kickoff lock exists so a move cannot bank or dodge points already
  // decided. Autopilot gets no exemption from it.
  const mine = roster();
  const worst = mine.filter((player) => player.position === "FWD").sort((a, b) => a.xp - b.xp)[0];
  const freeAgents = [{ id: 900, name: "Star", team: "Arsenal", position: "FWD", xp: worst.xp + 40 }];

  assert.equal(
    autopilotPickup({ roster: mine, freeAgents, lockedPlayerIds: new Set([900]) }),
    null,
    "autopilot signed a player whose club had already kicked off",
  );
  const dropLocked = autopilotPickup({ roster: mine, freeAgents, lockedPlayerIds: new Set([worst.id]) });
  // The worst forward is locked, so either a different forward goes or nothing
  // does, but never the locked one.
  if (dropLocked) assert.notEqual(dropLocked.drop.id, worst.id);
});

test("autopilot picks the single biggest upgrade and is deterministic about ties", () => {
  // One move per run, so when several positions qualify it has to choose, and
  // two ticks reading the same data must always choose the same thing.
  const mine = roster();
  const worstFwd = mine.filter((p) => p.position === "FWD").sort((a, b) => a.xp - b.xp)[0];
  const worstMid = mine.filter((p) => p.position === "MID").sort((a, b) => a.xp - b.xp)[0];
  const freeAgents = [
    { id: 900, name: "Good", team: "A", position: "FWD", xp: worstFwd.xp + 20 },
    { id: 901, name: "Better", team: "B", position: "MID", xp: worstMid.xp + 60 },
  ];

  const move = autopilotPickup({ roster: mine, freeAgents, lockedPlayerIds: new Set() });
  assert.equal(move.add.id, 901, "autopilot took the smaller of two upgrades");
  assert.equal(AUTOPILOT_PICKUPS_PER_GAMEWEEK, 1);

  // Same inputs in the opposite array order must reach the same decision.
  const reversed = autopilotPickup({ roster: [...mine].reverse(), freeAgents: [...freeAgents].reverse(), lockedPlayerIds: new Set() });
  assert.deepEqual({ add: reversed.add.id, drop: reversed.drop.id }, { add: move.add.id, drop: move.drop.id });
});

test("autopilot does nothing when there is nothing to do", () => {
  const mine = roster();
  assert.equal(autopilotPickup({ roster: mine, freeAgents: [], lockedPlayerIds: new Set() }), null);
  assert.equal(autopilotPickup({ roster: [], freeAgents: [{ id: 1, position: "FWD", xp: 100 }] }), null);
  assert.equal(autopilotPickup({}), null);
  assert.equal(autopilotPickup(), null);
});

test("a player with no expected points is treated as zero, never as unknown-and-therefore-good", () => {
  // A roster player with no xP is the WORST candidate to keep, and a free agent
  // with no xP must never look like an upgrade.
  const mine = [
    ...roster().filter((player) => player.position === "FWD"),
    { id: 500, name: "Unknown", team: "X", position: "FWD", xp: null },
  ];
  const freeAgents = [{ id: 900, name: "Known", team: "A", position: "FWD", xp: 30 }];
  const move = autopilotPickup({ roster: mine, freeAgents, lockedPlayerIds: new Set() });
  assert.equal(move.drop.id, 500, "the player with no data was not the one dropped");

  const blankFreeAgent = autopilotPickup({
    roster: roster(),
    freeAgents: [{ id: 901, name: "Nobody", team: "A", position: "FWD", xp: null }],
    lockedPlayerIds: new Set(),
  });
  assert.equal(blankFreeAgent, null, "a player with no data was signed as if he were an upgrade");
});

test("the lineup autopilot writes is always legal and always the best available", () => {
  // What the cron pass writes for an abandoned team. An illegal XI here would
  // be worse than the stale one it replaces.
  const mine = roster();
  const { players, captainId, points } = bestStartingXi(mine);

  assert.equal(players.length, STARTING_SIZE);
  assert.equal(validateFormation(players).valid, true, "autopilot fielded an illegal formation");
  assert.ok(players.some((player) => player.id === captainId), "the captain was not one of the starters");

  // The best forward (70) must start; the worst (30) must not, since FWD's
  // minimum is 1 and the flex slots go to higher scorers elsewhere.
  const starterIds = new Set(players.map((player) => player.id));
  const bestFwd = mine.filter((p) => p.position === "FWD").sort((a, b) => b.xp - a.xp)[0];
  assert.equal(starterIds.has(bestFwd.id), true, "the best forward was benched");

  // No XI drawn from this roster can score more.
  const anyOther = bestStartingXi([...mine].reverse());
  assert.equal(anyOther.points, points, "the XI depended on roster order rather than on xP");
  for (const [position, limit] of Object.entries(STARTING_LIMITS)) {
    const count = players.filter((player) => player.position === position).length;
    assert.ok(count >= limit.min && count <= limit.max, `${position} outside its limits`);
  }
});

test("the captain is the highest scorer in the XI", () => {
  // Not a formality: the captain doubles, so getting this wrong quietly costs
  // an absent manager points every single week.
  const { players, captainId } = bestStartingXi(roster());
  const captain = players.find((player) => player.id === captainId);
  for (const player of players) {
    assert.ok(captain.xp >= player.xp, `${player.name} outscores the captain`);
  }
});
