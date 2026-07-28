import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_FAAB_BUDGET,
  WAIVER_MODES,
  WAIVER_QUIET_PERIOD_MS,
  WAIVER_SETTLE_BUFFER_MS,
  claimGameweek,
  nextRollingPriorities,
  orderClaims,
  playerAvailability,
  resolveWaiverRun,
  validateAcquisition,
  waiverRunReady,
  waiverRunWindow,
} from "../src/fantasyWaivers.js";

const DAY = 24 * 60 * 60 * 1000;

// -- playerAvailability -------------------------------------------------------

test("playerAvailability classifies owned, on-waivers and free-agent players", () => {
  const ownedIds = new Set([1]);
  const wireIds = new Set([2]);
  assert.equal(playerAvailability({ playerId: 1, ownedIds, wireIds }), "owned");
  assert.equal(playerAvailability({ playerId: 2, ownedIds, wireIds }), "on_waivers");
  assert.equal(playerAvailability({ playerId: 3, ownedIds, wireIds }), "free_agent");
});

test("playerAvailability accepts plain arrays as well as Sets", () => {
  assert.equal(playerAvailability({ playerId: 1, ownedIds: [1, 2], wireIds: [] }), "owned");
  assert.equal(playerAvailability({ playerId: 2, ownedIds: [], wireIds: [2] }), "on_waivers");
});

test("owned takes precedence if a player id somehow appears in both sets", () => {
  assert.equal(playerAvailability({ playerId: 1, ownedIds: [1], wireIds: [1] }), "owned");
});

// -- validateAcquisition ------------------------------------------------------

const roster = [
  { id: 10, position: "GK" },
  { id: 11, position: "DEF" },
  { id: 12, position: "MID" },
];

test("validateAcquisition accepts a legal free-agent swap", () => {
  const result = validateAcquisition({
    addPlayer: { id: 20, position: "DEF" },
    dropPlayer: { id: 11, position: "DEF" },
    roster,
    availability: "free_agent",
    path: "free_agent",
    mode: "faab",
  });
  assert.deepEqual(result, { ok: true });
});

test("validateAcquisition rejects a free-agent-path add that is actually on waivers", () => {
  const result = validateAcquisition({
    addPlayer: { id: 20, position: "DEF" },
    dropPlayer: { id: 11, position: "DEF" },
    roster,
    availability: "on_waivers",
    path: "free_agent",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "Player is not a free agent");
});

test("validateAcquisition rejects a waiver-path add that is actually a free agent", () => {
  const result = validateAcquisition({
    addPlayer: { id: 20, position: "DEF" },
    dropPlayer: { id: 11, position: "DEF" },
    roster,
    availability: "free_agent",
    path: "waiver",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "Player is not on waivers");
});

test("validateAcquisition rejects dropping a player the claimant does not own", () => {
  const result = validateAcquisition({
    addPlayer: { id: 20, position: "DEF" },
    dropPlayer: { id: 999, position: "DEF" },
    roster,
    availability: "free_agent",
    path: "free_agent",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "You do not own that player");
});

test("validateAcquisition rejects a mismatched position pair", () => {
  const result = validateAcquisition({
    addPlayer: { id: 20, position: "FWD" },
    dropPlayer: { id: 11, position: "DEF" },
    roster,
    availability: "free_agent",
    path: "free_agent",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "Positions must match");
});

test("validateAcquisition rejects adding a player already owned by the claimant", () => {
  const result = validateAcquisition({
    addPlayer: { id: 12, position: "MID" },
    dropPlayer: { id: 11, position: "DEF" },
    roster,
    availability: "free_agent",
    path: "free_agent",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "You already own that player");
});

test("validateAcquisition allows a zero bid in faab mode", () => {
  const result = validateAcquisition({
    addPlayer: { id: 20, position: "DEF" },
    dropPlayer: { id: 11, position: "DEF" },
    roster,
    availability: "on_waivers",
    path: "waiver",
    mode: "faab",
    bid: 0,
    budgetRemaining: 50,
  });
  assert.deepEqual(result, { ok: true });
});

test("validateAcquisition rejects a bid over the remaining budget", () => {
  const result = validateAcquisition({
    addPlayer: { id: 20, position: "DEF" },
    dropPlayer: { id: 11, position: "DEF" },
    roster,
    availability: "on_waivers",
    path: "waiver",
    mode: "faab",
    bid: 60,
    budgetRemaining: 50,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "Not enough budget");
});

test("validateAcquisition rejects a negative or fractional bid", () => {
  const negative = validateAcquisition({
    addPlayer: { id: 20, position: "DEF" },
    dropPlayer: { id: 11, position: "DEF" },
    roster,
    availability: "on_waivers",
    path: "waiver",
    mode: "faab",
    bid: -1,
    budgetRemaining: 50,
  });
  assert.equal(negative.ok, false);

  const fractional = validateAcquisition({
    addPlayer: { id: 20, position: "DEF" },
    dropPlayer: { id: 11, position: "DEF" },
    roster,
    availability: "on_waivers",
    path: "waiver",
    mode: "faab",
    bid: 4.5,
    budgetRemaining: 50,
  });
  assert.equal(fractional.ok, false);
});

// -- orderClaims ---------------------------------------------------------------

test("orderClaims sorts faab claims by highest bid first", () => {
  const claims = [
    { claimId: 1, userId: 1, addPlayerId: 100, dropPlayerId: 10, bid: 5, priority: 1 },
    { claimId: 2, userId: 2, addPlayerId: 101, dropPlayerId: 11, bid: 20, priority: 1 },
    { claimId: 3, userId: 3, addPlayerId: 102, dropPlayerId: 12, bid: 10, priority: 1 },
  ];
  const ordered = orderClaims(claims, { mode: "faab", priorities: [] });
  assert.deepEqual(ordered.map((c) => c.claimId), [2, 3, 1]);
});

test("orderClaims breaks a faab bid tie by league table position, worst record first", () => {
  const claims = [
    { claimId: 1, userId: 1, addPlayerId: 100, dropPlayerId: 10, bid: 10, priority: 1 },
    { claimId: 2, userId: 2, addPlayerId: 101, dropPlayerId: 11, bid: 10, priority: 1 },
  ];
  // standingsFromFixtures returns best first, so userId 2 is bottom of the table.
  const standings = [{ userId: 1 }, { userId: 2 }];
  // The stored queue deliberately favours userId 1, to prove the table wins.
  const priorities = [
    { userId: 1, priority: 1 },
    { userId: 2, priority: 3 },
  ];
  const ordered = orderClaims(claims, { mode: "faab", priorities, standings });
  assert.deepEqual(ordered.map((c) => c.claimId), [2, 1]); // bottom of the table takes the tie
});

test("orderClaims falls back to the stored queue for a faab tie before any gameweek has completed", () => {
  const claims = [
    { claimId: 1, userId: 1, addPlayerId: 100, dropPlayerId: 10, bid: 10, priority: 1 },
    { claimId: 2, userId: 2, addPlayerId: 101, dropPlayerId: 11, bid: 10, priority: 1 },
  ];
  const priorities = [
    { userId: 1, priority: 3 },
    { userId: 2, priority: 1 },
  ];
  const ordered = orderClaims(claims, { mode: "faab", priorities, standings: [] });
  assert.deepEqual(ordered.map((c) => c.claimId), [2, 1]); // no table yet, so the queue decides
});

test("orderClaims falls back to the claimant's own claim order after bid and league priority ties", () => {
  const claims = [
    { claimId: 5, userId: 1, addPlayerId: 100, dropPlayerId: 10, bid: 10, priority: 2 },
    { claimId: 4, userId: 1, addPlayerId: 101, dropPlayerId: 11, bid: 10, priority: 1 },
  ];
  const ordered = orderClaims(claims, { mode: "faab", priorities: [] });
  assert.deepEqual(ordered.map((c) => c.claimId), [4, 5]); // priority 1 tried before priority 2
});

test("orderClaims falls back to claim id when everything else ties", () => {
  const claims = [
    { claimId: 9, userId: 1, addPlayerId: 100, dropPlayerId: 10, bid: 10, priority: 1 },
    { claimId: 3, userId: 1, addPlayerId: 101, dropPlayerId: 11, bid: 10, priority: 1 },
  ];
  const ordered = orderClaims(claims, { mode: "faab", priorities: [] });
  assert.deepEqual(ordered.map((c) => c.claimId), [3, 9]);
});

test("orderClaims in rolling mode orders by league waiver priority ascending", () => {
  const claims = [
    { claimId: 1, userId: 1, addPlayerId: 100, dropPlayerId: 10, priority: 1 },
    { claimId: 2, userId: 2, addPlayerId: 101, dropPlayerId: 11, priority: 1 },
    { claimId: 3, userId: 3, addPlayerId: 102, dropPlayerId: 12, priority: 1 },
  ];
  const priorities = [
    { userId: 1, priority: 3 },
    { userId: 2, priority: 1 },
    { userId: 3, priority: 2 },
  ];
  const ordered = orderClaims(claims, { mode: "rolling", priorities });
  assert.deepEqual(ordered.map((c) => c.claimId), [2, 3, 1]);
});

test("orderClaims in reverse_standings mode orders worst record first", () => {
  const claims = [
    { claimId: 1, userId: 1, addPlayerId: 100, dropPlayerId: 10, priority: 1 },
    { claimId: 2, userId: 2, addPlayerId: 101, dropPlayerId: 11, priority: 1 },
    { claimId: 3, userId: 3, addPlayerId: 102, dropPlayerId: 12, priority: 1 },
  ];
  // Best to worst per standingsFromFixtures' own convention.
  const standings = [{ userId: 1 }, { userId: 2 }, { userId: 3 }];
  const ordered = orderClaims(claims, { mode: "reverse_standings", standings });
  assert.deepEqual(ordered.map((c) => c.claimId), [3, 2, 1]); // userId 3 is worst-placed, goes first
});

test("orderClaims is deterministic: identical input always produces identical order", () => {
  const claims = [
    { claimId: 1, userId: 1, addPlayerId: 100, dropPlayerId: 10, bid: 10, priority: 1 },
    { claimId: 2, userId: 2, addPlayerId: 101, dropPlayerId: 11, bid: 10, priority: 1 },
    { claimId: 3, userId: 3, addPlayerId: 102, dropPlayerId: 12, bid: 15, priority: 1 },
  ];
  const priorities = [
    { userId: 1, priority: 2 },
    { userId: 2, priority: 1 },
    { userId: 3, priority: 3 },
  ];
  const first = orderClaims(claims, { mode: "faab", priorities });
  const second = orderClaims(claims, { mode: "faab", priorities });
  assert.deepEqual(first, second);
});

// -- resolveWaiverRun ----------------------------------------------------------

const players = new Map([
  [10, { position: "DEF" }],
  [11, { position: "DEF" }],
  [12, { position: "MID" }],
  [100, { position: "DEF" }], // wire target, contested
  [101, { position: "MID" }], // wire target, uncontested
]);

function baseOwnedBy() {
  return new Map([
    [10, 1],
    [12, 1],
    [11, 2],
  ]);
}

test("faab: highest bid wins a contested wire player, loser is Outbid", () => {
  const claims = [
    { claimId: 1, userId: 1, addPlayerId: 100, dropPlayerId: 10, bid: 20, priority: 1 },
    { claimId: 2, userId: 2, addPlayerId: 100, dropPlayerId: 11, bid: 15, priority: 1 },
  ];
  const budgets = new Map([
    [1, 100],
    [2, 100],
  ]);
  const run = resolveWaiverRun({
    claims,
    mode: "faab",
    ownedBy: baseOwnedBy(),
    budgets,
    priorities: [],
    players,
  });

  const winner = run.results.find((r) => r.claimId === 1);
  const loser = run.results.find((r) => r.claimId === 2);
  assert.equal(winner.status, "processed");
  assert.equal(loser.status, "rejected");
  assert.equal(loser.reason, "Outbid");
  assert.deepEqual(run.rosterChanges, [{ userId: 1, addPlayerId: 100, dropPlayerId: 10 }]);
  assert.deepEqual(run.wireAdds, [10]);
  assert.deepEqual(run.budgets.find((b) => b.userId === 1), { userId: 1, remaining: 80 });
});

test("rolling: a contested wire player's loser is rejected as Player already claimed", () => {
  const claims = [
    { claimId: 1, userId: 1, addPlayerId: 100, dropPlayerId: 10, priority: 1 },
    { claimId: 2, userId: 2, addPlayerId: 100, dropPlayerId: 11, priority: 1 },
  ];
  const priorities = [
    { userId: 1, priority: 1 },
    { userId: 2, priority: 2 },
  ];
  const run = resolveWaiverRun({
    claims,
    mode: "rolling",
    ownedBy: baseOwnedBy(),
    budgets: new Map(),
    priorities,
    players,
  });
  const loser = run.results.find((r) => r.claimId === 2);
  assert.equal(loser.status, "rejected");
  assert.equal(loser.reason, "Player already claimed");
});

test("faab: a manager can win two claims in one run, second bid checked against decremented budget", () => {
  const claims = [
    { claimId: 1, userId: 1, addPlayerId: 100, dropPlayerId: 10, bid: 60, priority: 1 },
    { claimId: 2, userId: 1, addPlayerId: 101, dropPlayerId: 12, bid: 45, priority: 2 },
  ];
  const budgets = new Map([[1, 100]]);
  const run = resolveWaiverRun({
    claims,
    mode: "faab",
    ownedBy: baseOwnedBy(),
    budgets,
    priorities: [],
    players,
  });
  const second = run.results.find((r) => r.claimId === 2);
  assert.equal(second.status, "rejected");
  assert.equal(second.reason, "Not enough budget"); // 100 - 60 = 40 remaining, bid was 45
  assert.equal(run.results.find((r) => r.claimId === 1).status, "processed");
});

test("faab: two affordable wins in one run both process and decrement sequentially", () => {
  const claims = [
    { claimId: 1, userId: 1, addPlayerId: 100, dropPlayerId: 10, bid: 60, priority: 1 },
    { claimId: 2, userId: 1, addPlayerId: 101, dropPlayerId: 12, bid: 30, priority: 2 },
  ];
  const budgets = new Map([[1, 100]]);
  const run = resolveWaiverRun({
    claims,
    mode: "faab",
    ownedBy: baseOwnedBy(),
    budgets,
    priorities: [],
    players,
  });
  assert.equal(run.results.every((r) => r.status === "processed"), true);
  assert.deepEqual(run.budgets.find((b) => b.userId === 1), { userId: 1, remaining: 10 });
  assert.deepEqual(
    run.rosterChanges.sort((a, b) => a.addPlayerId - b.addPlayerId),
    [
      { userId: 1, addPlayerId: 100, dropPlayerId: 10 },
      { userId: 1, addPlayerId: 101, dropPlayerId: 12 },
    ],
  );
});

test("a claim whose drop player was already used by that manager's earlier winning claim is rejected", () => {
  // Both of userId 1's claims declare the SAME drop player; only the first can win it.
  const claims = [
    { claimId: 1, userId: 1, addPlayerId: 100, dropPlayerId: 10, bid: 10, priority: 1 },
    { claimId: 2, userId: 1, addPlayerId: 101, dropPlayerId: 10, bid: 5, priority: 2 },
  ];
  const budgets = new Map([[1, 100]]);
  const run = resolveWaiverRun({
    claims,
    mode: "faab",
    ownedBy: baseOwnedBy(),
    budgets,
    priorities: [],
    players,
  });
  const second = run.results.find((r) => r.claimId === 2);
  assert.equal(second.status, "rejected");
  assert.equal(second.reason, "You no longer hold that player");
});

test("resolveWaiverRun rejects a stale claim whose positions no longer match", () => {
  const mismatchedPlayers = new Map(players);
  mismatchedPlayers.set(100, { position: "FWD" }); // was DEF at claim time, drifted before the run
  const claims = [{ claimId: 1, userId: 1, addPlayerId: 100, dropPlayerId: 10, bid: 5, priority: 1 }];
  const run = resolveWaiverRun({
    claims,
    mode: "faab",
    ownedBy: baseOwnedBy(),
    budgets: new Map([[1, 100]]),
    priorities: [],
    players: mismatchedPlayers,
  });
  assert.equal(run.results[0].status, "rejected");
  assert.equal(run.results[0].reason, "Positions must match");
});

test("resolveWaiverRun respects a manager's own claim order (own priority) for independent claims", () => {
  const claims = [
    { claimId: 1, userId: 1, addPlayerId: 101, dropPlayerId: 12, bid: 5, priority: 2 },
    { claimId: 2, userId: 1, addPlayerId: 100, dropPlayerId: 10, bid: 5, priority: 1 },
  ];
  const run = resolveWaiverRun({
    claims,
    mode: "faab",
    ownedBy: baseOwnedBy(),
    budgets: new Map([[1, 100]]),
    priorities: [],
    players,
  });
  // Both are affordable and uncontested, so both process; ordering itself is
  // checked via orderClaims' own tests, this just confirms both still land.
  assert.equal(run.results.every((r) => r.status === "processed"), true);
});

test("resolveWaiverRun is deterministic: identical input always produces identical output", () => {
  const claims = [
    { claimId: 1, userId: 1, addPlayerId: 100, dropPlayerId: 10, bid: 20, priority: 1 },
    { claimId: 2, userId: 2, addPlayerId: 100, dropPlayerId: 11, bid: 15, priority: 1 },
  ];
  const budgets = new Map([
    [1, 100],
    [2, 100],
  ]);
  const first = resolveWaiverRun({
    claims,
    mode: "faab",
    ownedBy: baseOwnedBy(),
    budgets,
    priorities: [],
    players,
  });
  const second = resolveWaiverRun({
    claims,
    mode: "faab",
    ownedBy: baseOwnedBy(),
    budgets: new Map([
      [1, 100],
      [2, 100],
    ]),
    priorities: [],
    players,
  });
  assert.deepEqual(first, second);
});

test("resolveWaiverRun rejects a claim whose addPlayerId equals its dropPlayerId, engine-level", () => {
  // validateAcquisition already blocks this at submission time, but the
  // engine must not rely on that: workingOwnedBy.get(dropPlayerId) trivially
  // equals userId for a same-player claim (they still hold it) and
  // addPosition/dropPosition trivially match, so without an explicit guard
  // this would process, wrongly land the player in wireAdds while it stays
  // on the roster, and leave the engine's own ownership bookkeeping (the
  // set-then-immediately-delete of the same playerId) out of sync with the
  // roster write the caller would perform.
  const claims = [{ claimId: 1, userId: 1, addPlayerId: 10, dropPlayerId: 10, bid: 5, priority: 1 }];
  const run = resolveWaiverRun({
    claims,
    mode: "faab",
    ownedBy: baseOwnedBy(),
    budgets: new Map([[1, 100]]),
    priorities: [],
    players,
  });
  assert.equal(run.results[0].status, "rejected");
  assert.equal(run.results[0].reason, "Cannot add and drop the same player");
  assert.deepEqual(run.rosterChanges, []);
  assert.deepEqual(run.wireAdds, []);
});

test("resolveWaiverRun rejects add-equals-drop the same way regardless of mode", () => {
  const claims = [{ claimId: 1, userId: 1, addPlayerId: 10, dropPlayerId: 10, priority: 1 }];
  const run = resolveWaiverRun({
    claims,
    mode: "rolling",
    ownedBy: baseOwnedBy(),
    budgets: new Map(),
    priorities: [{ userId: 1, priority: 1 }],
    players,
  });
  assert.equal(run.results[0].status, "rejected");
  assert.equal(run.results[0].reason, "Cannot add and drop the same player");
});

// -- nextRollingPriorities ------------------------------------------------------

test("nextRollingPriorities moves winners to the back, preserving relative order both sides", () => {
  const priorities = [
    { userId: 1, priority: 1 },
    { userId: 2, priority: 2 },
    { userId: 3, priority: 3 },
    { userId: 4, priority: 4 },
  ];
  // userId 1 and 3 won a claim this run.
  const next = nextRollingPriorities(priorities, new Set([1, 3]));
  assert.deepEqual(next, [
    { userId: 2, priority: 1 },
    { userId: 4, priority: 2 },
    { userId: 1, priority: 3 },
    { userId: 3, priority: 4 },
  ]);
});

test("nextRollingPriorities is a no-op reordering when nobody won a claim", () => {
  const priorities = [
    { userId: 1, priority: 1 },
    { userId: 2, priority: 2 },
  ];
  const next = nextRollingPriorities(priorities, new Set());
  assert.deepEqual(next, priorities);
});

test("nextRollingPriorities accepts a plain array of winner ids too", () => {
  const priorities = [
    { userId: 1, priority: 1 },
    { userId: 2, priority: 2 },
  ];
  const next = nextRollingPriorities(priorities, [1]);
  assert.deepEqual(next, [
    { userId: 2, priority: 1 },
    { userId: 1, priority: 2 },
  ]);
});

// -- sanity on the exported constants ------------------------------------------

test("WAIVER_MODES and DEFAULT_FAAB_BUDGET are the agreed values", () => {
  assert.deepEqual(WAIVER_MODES, ["faab", "rolling", "reverse_standings"]);
  assert.equal(DEFAULT_FAAB_BUDGET, 100);
});

// -- the settlement buffer ------------------------------------------------------

// Matches carry an explicit `gameweek` here (what assignGameweeks stamps on),
// so these tests exercise the window logic rather than re-testing the calendar.
function fixture(gameweek, utcDate) {
  return { gameweek, matchday: gameweek, status: "SCHEDULED", utcDate, homeTeam: "A", awayTeam: "B" };
}

const GW10_LAST_KICKOFF = Date.parse("2026-11-08T16:30:00Z");
const GW10 = [fixture(10, "2026-11-07T12:30:00Z"), fixture(10, "2026-11-08T16:30:00Z")];
const GW11 = [fixture(11, "2026-11-21T15:00:00Z")];

test("waiverRunWindow hangs both instants off the gameweek's last kickoff", () => {
  const window = waiverRunWindow({ matches: GW10, gameweek: 10, now: GW10_LAST_KICKOFF - DAY });
  assert.equal(window.deadline, GW10_LAST_KICKOFF);
  assert.equal(window.quietFrom, GW10_LAST_KICKOFF - WAIVER_QUIET_PERIOD_MS);
  assert.equal(window.earliestRunAt, GW10_LAST_KICKOFF + WAIVER_SETTLE_BUFFER_MS);
  assert.equal(window.phase, "open");
});

test("waiverRunWindow moves through open, quiet and closed as the clock advances", () => {
  const at = (offset) => waiverRunWindow({ matches: GW10, gameweek: 10, now: GW10_LAST_KICKOFF + offset }).phase;
  assert.equal(at(-WAIVER_QUIET_PERIOD_MS - 1), "open");
  assert.equal(at(-WAIVER_QUIET_PERIOD_MS), "quiet"); // the quiet period is inclusive at its start
  assert.equal(at(0), "quiet");
  assert.equal(at(WAIVER_SETTLE_BUFFER_MS - 1), "quiet");
  assert.equal(at(WAIVER_SETTLE_BUFFER_MS), "closed");
});

test("waiverRunWindow stays open for a gameweek with no datable fixture", () => {
  // A fully blank window, or a feed that has published no kickoffs: there is
  // no timetable to enforce, so this fails open to the pre-buffer behaviour
  // rather than freezing every claim on missing data.
  const window = waiverRunWindow({ matches: [], gameweek: 10, now: GW10_LAST_KICKOFF });
  assert.deepEqual(window, { gameweek: 10, deadline: null, quietFrom: null, earliestRunAt: null, phase: "open" });
});

test("claimGameweek keeps a claim in the current run while the window is open", () => {
  const target = claimGameweek({
    matches: [...GW10, ...GW11],
    currentGameweek: 10,
    now: GW10_LAST_KICKOFF - DAY,
  });
  assert.equal(target.gameweek, 10);
  assert.equal(target.deferred, false);
  assert.equal(target.runsAfter, GW10_LAST_KICKOFF + WAIVER_SETTLE_BUFFER_MS);
});

test("claimGameweek defers a claim submitted in the quiet period to the next run", () => {
  // The whole point of the buffer: a claim landing an instant before the run
  // is never silently included, never silently dropped and never rejected. It
  // is accepted, explicitly tagged with the next gameweek, and says so.
  const target = claimGameweek({
    matches: [...GW10, ...GW11],
    currentGameweek: 10,
    now: GW10_LAST_KICKOFF - 1000,
  });
  assert.equal(target.gameweek, 11);
  assert.equal(target.deferred, true);
  assert.equal(target.runsAfter, Date.parse("2026-11-21T15:00:00Z") + WAIVER_SETTLE_BUFFER_MS);
});

test("waiverRunReady holds the run back until the settlement buffer has elapsed", () => {
  const ready = (offset) =>
    waiverRunReady({ matches: GW10, settledGameweek: 10, now: GW10_LAST_KICKOFF + offset });
  // Every match can be terminal barely two hours after the last kickoff; the
  // run still waits, so the gap between the last acceptable claim and the run
  // reading the claim set is never a matter of milliseconds.
  assert.equal(ready(2 * 60 * 60 * 1000), false);
  assert.equal(ready(WAIVER_SETTLE_BUFFER_MS - 1), false);
  assert.equal(ready(WAIVER_SETTLE_BUFFER_MS), true);
});

test("waiverRunReady fails open when there is no timetable to wait for", () => {
  assert.equal(waiverRunReady({ matches: null, settledGameweek: 10, now: Date.now() }), true);
  assert.equal(waiverRunReady({ matches: GW10, settledGameweek: 10, now: undefined }), true);
});

test("the guaranteed gap between the last acceptable claim and the run is hours, not milliseconds", () => {
  // The property the owner actually asked for, asserted as one number rather
  // than left implicit in the two constants.
  const lastClaimAt = GW10_LAST_KICKOFF - WAIVER_QUIET_PERIOD_MS - 1;
  const runAt = waiverRunWindow({ matches: GW10, gameweek: 10, now: lastClaimAt }).earliestRunAt;
  assert.ok(runAt - lastClaimAt >= WAIVER_QUIET_PERIOD_MS + WAIVER_SETTLE_BUFFER_MS);
});
