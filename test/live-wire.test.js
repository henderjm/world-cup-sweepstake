import assert from "node:assert/strict";
import test from "node:test";

import {
  WIRE_KINDS,
  confirmedGoals,
  describeImpact,
  describeWireItem,
  reconcileWire,
  sortWireItems,
  wireAiEligible,
  wireItemsForMatch,
  wirePulse,
  wireWatching,
} from "../src/liveWire.js";
import { buildWirePrompt, wireLineAcceptable } from "../src/liveWirePrompt.js";

const KICKOFF = "2026-10-20T19:00:00.000Z";

const match = (over = {}) => ({
  id: 101,
  utcDate: KICKOFF,
  status: "IN_PLAY",
  providerStatus: "1H",
  minute: 30,
  homeTeam: "Liverpool",
  awayTeam: "Villarreal",
  score: { home: 1, away: 0 },
  penalties: null,
  ...over,
});

const goal = (team, minute, scorer, over = {}) => ({
  minute, injuryTime: null, type: "REGULAR", team, scorerId: scorer.length, scorer, assistId: null, assist: null, ...over,
});

const keys = (items) => items.map(item => item.key);

test("a goal the score has not reached yet is not on the wire", () => {
  // Events and score travel by different paths; a goal shows only once both agree.
  const detail = { goals: [goal("Liverpool", 24, "Salah"), goal("Liverpool", 29, "Gakpo")] };
  const items = wireItemsForMatch({ competition: "CL", match: match(), detail });
  assert.deepEqual(keys(items.filter(item => item.kind === WIRE_KINDS.GOAL)), ["g:101:home:1"]);
});

test("penalty-shootout kicks never leak in as goals", () => {
  const detail = {
    goals: [
      goal("Liverpool", 60, "Salah"),
      goal("Villarreal", 75, "Moreno"),
      // A shootout: the mapper keeps these as Goal / Penalty events.
      goal("Liverpool", 120, "Salah", { type: "PENALTY" }),
      goal("Villarreal", 120, "Parejo", { type: "PENALTY" }),
    ],
  };
  const finished = match({ status: "FINISHED", providerStatus: "PEN", minute: 120,
    score: { home: 1, away: 1 }, penalties: { home: 4, away: 2 } });
  const goals = confirmedGoals(finished, detail);
  assert.equal(goals.length, 2);
  const ft = wireItemsForMatch({ competition: "CL", match: finished, detail }).find(item => item.kind === "fulltime");
  assert.match(describeWireItem(ft).line, /4–2 on penalties/);
});

test("story tags: opener, equaliser, comeback, brace, late", () => {
  const detail = {
    goals: [
      goal("Villarreal", 10, "Moreno"),
      goal("Liverpool", 50, "Salah"),
      goal("Liverpool", 88, "Salah"),
    ],
  };
  const live = match({ minute: 89, providerStatus: "2H", score: { home: 2, away: 1 } });
  const goals = confirmedGoals(live, detail);
  assert.deepEqual(goals[0].tags, ["opener"]);
  assert.deepEqual(goals[1].tags, ["equaliser"]);
  assert.ok(goals[2].tags.includes("comeback"));
  assert.ok(goals[2].tags.includes("brace"));
  assert.ok(goals[2].tags.includes("late"));
});

test("keys are stable across ticks so only new events insert", () => {
  const detail = { goals: [goal("Liverpool", 24, "Salah")], cards: [], subs: [] };
  const first = wireItemsForMatch({ competition: "CL", match: match(), detail });
  const second = wireItemsForMatch({ competition: "CL", match: match({ minute: 31 }), detail });
  const { inserts, updates, retire } = reconcileWire({ stored: first, current: second, match: match(), detail, detailTrusted: true });
  assert.deepEqual([inserts, updates, retire], [[], [], []]);
});

test("a corrected scorer rewrites the goal in place instead of adding a second goal", () => {
  const before = wireItemsForMatch({ competition: "CL", match: match(), detail: { goals: [goal("Liverpool", 24, "Salah")] } });
  const after = wireItemsForMatch({ competition: "CL", match: match(), detail: { goals: [goal("Liverpool", 24, "Gakpo")] } });
  const result = reconcileWire({ stored: before, current: after, match: match(), detail: {}, detailTrusted: true });
  assert.equal(result.inserts.length, 0);
  assert.equal(result.updates.length, 1);
  assert.equal(result.updates[0].key, "g:101:home:1");
  assert.equal(result.updates[0].player, "Gakpo");
});

test("a goal ruled out needs BOTH the score and the events to drop", () => {
  const stored = wireItemsForMatch({ competition: "CL", match: match(), detail: { goals: [goal("Liverpool", 24, "Salah")] } });
  const disallowed = match({ minute: 27, score: { home: 0, away: 0 } });

  // Score dropped but the events still carry it: a blip, nothing retired.
  const blip = reconcileWire({ stored, current: wireItemsForMatch({ competition: "CL", match: disallowed, detail: { goals: [goal("Liverpool", 24, "Salah")] } }),
    match: disallowed, detail: { goals: [goal("Liverpool", 24, "Salah")] }, detailTrusted: true });
  assert.deepEqual(blip.retire, []);

  // A degraded read (empty events) is never evidence.
  const degraded = reconcileWire({ stored, current: [], match: disallowed, detail: { goals: [] }, detailTrusted: false });
  assert.deepEqual(degraded.retire, []);

  const ruledOut = reconcileWire({ stored, current: wireItemsForMatch({ competition: "CL", match: disallowed, detail: { goals: [] } }),
    match: disallowed, detail: { goals: [] }, detailTrusted: true });
  assert.deepEqual(ruledOut.retire, ["g:101:home:1"]);
  const overturned = ruledOut.inserts.find(item => item.kind === WIRE_KINDS.OVERTURNED);
  assert.equal(overturned.key, "x:g:101:home:1");
  assert.match(describeWireItem(overturned).line, /Salah's goal no longer stands. Liverpool 0–0 Villarreal/);
});

test("only fresh big moments go to the model", () => {
  const live = match({ minute: 30 });
  const fresh = { kind: "goal", minute: 27 };
  const stale = { kind: "goal", minute: 12 };
  assert.equal(wireAiEligible(fresh, live), true);
  assert.equal(wireAiEligible(stale, live), false);
  assert.equal(wireAiEligible({ kind: "card", card: "YELLOW", minute: 29 }, live), false);
  assert.equal(wireAiEligible({ kind: "card", card: "RED", minute: 29 }, live), true);
  assert.equal(wireAiEligible({ kind: "sub", minute: 30 }, live), false);
  const finished = match({ status: "FINISHED" });
  assert.equal(wireAiEligible({ kind: "fulltime" }, finished, { watchedLive: false }), false);
  assert.equal(wireAiEligible({ kind: "fulltime" }, finished, { watchedLive: true }), true);
});

test("half-time is inferred, never invented", () => {
  const atHt = wireItemsForMatch({ competition: "CL", match: match({ status: "PAUSED", providerStatus: "HT", minute: 45 }), detail: {} });
  assert.ok(atHt.some(item => item.kind === "halftime"));
  // First seen in the second half without a half-time score: no item.
  const noHt = wireItemsForMatch({ competition: "CL", match: match({ providerStatus: "2H", minute: 60 }), detail: { score: {} } });
  assert.ok(!noHt.some(item => item.kind === "halftime"));
  const withHt = wireItemsForMatch({ competition: "CL", match: match({ providerStatus: "2H", minute: 60 }), detail: { score: { htHome: 1, htAway: 0 } } });
  assert.deepEqual(withHt.find(item => item.kind === "halftime").score, { home: 1, away: 0 });
});

test("a red card says how many are left", () => {
  const detail = { cards: [{ minute: 29, team: "Liverpool", playerId: 7, player: "Konaté", card: "RED" }] };
  const red = wireItemsForMatch({ competition: "CL", match: match(), detail }).find(item => item.kind === "card");
  assert.equal(red.players, 10);
  assert.match(describeWireItem(red).line, /Liverpool are down to ten/);
});

test("the latest goal carries its table consequence as it stands", () => {
  const standings = [{ type: "TOTAL", group: null, table: [
    ["Arsenal", 2], ["Chelsea", 2], ["Spurs", 1], ["Liverpool", 0], ["Villarreal", 0],
  ].map(([name, points], index) => ({ position: index + 1, team: { name }, points })) }];
  const live = match({ score: { home: 1, away: 0 } });
  const table = {
    // played 0: applyLiveResults only folds a live match for clubs whose
    // provider count matches the finished matches the feed shows.
    rows: standings[0].table.map(row => ({ team: row.team.name, position: row.position, points: row.points,
      played: 0, won: 0, drawn: 0, lost: 0, goalDifference: 0, goalsFor: 0 })),
    matches: [live],
    zones: [{ from: 1, to: 2, label: "Top two" }],
    competitionCode: "PL",
  };
  // Before the goal it was 0-0, so Liverpool already had a live draw point (3rd).
  const items = wireItemsForMatch({ competition: "PL", match: live, detail: { goals: [goal("Liverpool", 24, "Salah")] }, table });
  const scored = items.find(item => item.kind === "goal");
  assert.deepEqual(scored.impact, { team: "Liverpool", from: 3, to: 1, zone: "Top two", zoneChanged: true });
  assert.equal(describeImpact(scored), "Liverpool up to 1st · Top two as it stands");
});

test("the model may not state a number the payload did not contain", () => {
  const item = wireItemsForMatch({ competition: "CL", match: match(), detail: { goals: [goal("Liverpool", 24, "Salah")] } })
    .find(entry => entry.kind === "goal");
  const payload = buildWirePrompt({ item, match: match(), elsewhere: [match({ id: 2, homeTeam: "Napoli", awayTeam: "Bodo/Glimt", score: { home: 0, away: 0 }, minute: 30 })] });
  assert.equal(wireLineAcceptable("Salah strikes and Anfield is rocking, ten minutes after Napoli stalled.", payload),
    "Salah strikes and Anfield is rocking, ten minutes after Napoli stalled.");
  assert.equal(wireLineAcceptable("His 47th Champions League goal.", payload), null);
  assert.equal(wireLineAcceptable("Big moment — truly.", payload), null);
  assert.equal(wireLineAcceptable("x".repeat(400), payload), null);
});

test("the timeline is newest first with a total order", () => {
  const items = sortWireItems([
    { key: "a", kind: "goal", at: "2026-10-20T19:10:00Z" },
    { key: "b", kind: "card", at: "2026-10-20T19:30:00Z" },
    { key: "c", kind: "goal", at: "2026-10-20T19:30:00Z" },
  ]);
  assert.deepEqual(keys(items), ["b", "c", "a"]);
});

test("the pulse names the match worth switching to, and nothing on a dull night", () => {
  const now = Date.parse("2026-10-20T20:40:00Z");
  const level = match({ id: 1, minute: 81, score: { home: 1, away: 1 } });
  const dull = match({ id: 2, minute: 81, score: { home: 3, away: 0 } });
  const pulse = wirePulse([level, dull], [], now);
  assert.equal(pulse.matchId, 1);
  assert.equal(pulse.reason, "Level at 81'");
  assert.equal(wirePulse([dull], [], now), null);
  const flurry = wirePulse([dull], [
    { matchId: 2, kind: "goal", receivedAt: "2026-10-20T20:35:00Z" },
    { matchId: 2, kind: "goal", receivedAt: "2026-10-20T20:38:00Z" },
  ], now);
  assert.equal(flurry.reason, "2 goals in the last few minutes");
});

test("the wire watches live matches and a window after kick-off", () => {
  const now = Date.parse(KICKOFF) + 60 * 60_000;
  assert.equal(wireWatching(match(), now), true);
  assert.equal(wireWatching(match({ status: "FINISHED" }), now), true);
  assert.equal(wireWatching(match({ status: "FINISHED" }), now + 5 * 60 * 60_000), false);
  assert.equal(wireWatching(match({ status: "TIMED" }), now), false);
});
