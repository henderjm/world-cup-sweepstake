import assert from "node:assert/strict";
import test from "node:test";

import {
  breakdownTitle,
  mergeMatchScoreRows,
  parseStoredScores,
  pointsBreakdownLines,
  provisionalPlayerIds,
  serializeScores,
  squadPointsLabel,
} from "../src/fantasyLivePoints.js";
import { sumPlayerPoints } from "../src/fantasyGameweek.js";

// Before this, a player's points did not exist until his match was FINISHED
// (runScheduledFantasyScoring filters on isMatchFinished), so during a game the
// My team pitch showed "in play" beside a zero and a manager watching their
// captain score had nothing to look at.
//
// The invariant every one of these protects: provisional points are for READING.
// They must never be counted twice against settled ones, and they never reach
// fantasy_gameweek_scores or fantasy_h2h_fixtures, whose rows are permanent.

// -- the handover ------------------------------------------------------------

test("a match settled since the last tick is counted once, from the settled side", () => {
  // The dangerous case: the scoring pass has written match 1, and the
  // provisional row for it has not been cleared yet. Counting both would double
  // every point in that match.
  const settled = [{ matchId: 1, playerId: 10, points: 7 }];
  const provisional = [{ matchId: 1, playerId: 10, points: 5 }];
  const merged = mergeMatchScoreRows({ settled, provisional });
  assert.equal(merged.length, 1);
  assert.equal(sumPlayerPoints(merged).get(10), 7);
});

test("a double gameweek sums a settled match and a live one", () => {
  // A club can play twice inside one window, so one match finished and another
  // under way is normal, and the total is a SUM across both.
  const settled = [{ matchId: 1, playerId: 10, points: 7 }];
  const provisional = [{ matchId: 2, playerId: 10, points: 5 }];
  const merged = mergeMatchScoreRows({ settled, provisional });
  assert.equal(sumPlayerPoints(merged).get(10), 12);
});

test("with nothing settled the provisional rows stand alone", () => {
  const merged = mergeMatchScoreRows({ settled: [], provisional: [{ matchId: 2, playerId: 4, points: 6 }] });
  assert.equal(sumPlayerPoints(merged).get(4), 6);
});

test("merging tolerates missing and junk input", () => {
  assert.deepEqual(mergeMatchScoreRows(), []);
  assert.deepEqual(mergeMatchScoreRows({}), []);
  assert.deepEqual(mergeMatchScoreRows({ settled: null, provisional: null }), []);
  const merged = mergeMatchScoreRows({ settled: [null], provisional: [null, { matchId: 3, playerId: 1, points: 2 }] });
  assert.equal(merged.length, 1);
});

// -- which players are still in play -----------------------------------------

test("a starter whose match has settled is no longer provisional", () => {
  // Per player, not per squad: a staggered gameweek leaves one starter done
  // while another is still on, and one flag would misdescribe both.
  const settled = [{ matchId: 1, playerId: 10, points: 7 }];
  const provisional = [
    { matchId: 1, playerId: 10, points: 5 }, // stale, his match settled
    { matchId: 2, playerId: 11, points: 3 }, // genuinely still playing
  ];
  const ids = provisionalPlayerIds(provisional, settled);
  assert.equal(ids.has(10), false);
  assert.equal(ids.has(11), true);
});

test("no provisional rows means nobody is provisional", () => {
  assert.equal(provisionalPlayerIds([], []).size, 0);
  assert.equal(provisionalPlayerIds(null, null).size, 0);
  assert.equal(provisionalPlayerIds([{ matchId: 1 }], []).size, 0); // no playerId
});

// -- the breakdown -----------------------------------------------------------

test("a breakdown is summed across matches and ordered for reading", () => {
  const lines = pointsBreakdownLines([
    { goals: 5, appearance: 2 },
    { appearance: 2, cards: -1 },
  ]);
  assert.deepEqual(
    lines.map((line) => [line.field, line.points]),
    [
      ["goals", 5],
      ["appearance", 4],
      ["cards", -1],
    ],
  );
});

test("zero categories are dropped rather than shown as +0", () => {
  const lines = pointsBreakdownLines([{ goals: 0, assists: 3, cleanSheet: 0 }]);
  assert.deepEqual(lines.map((line) => line.field), ["assists"]);
});

test("breakdown values are POINTS, and the label says so", () => {
  // scoreMatchForPlayers adds SCORING.goal[position], so a 10 under "goals" is
  // two midfield goals. Rendering it as a count would be a false statement.
  const lines = pointsBreakdownLines([{ goals: 10 }]);
  assert.deepEqual(lines, [{ field: "goals", label: "Goals", points: 10 }]);
  assert.equal(breakdownTitle(lines), "Goals +10");
});

test("the title signs both directions", () => {
  const lines = pointsBreakdownLines([{ goals: 5, cards: -3 }]);
  assert.equal(breakdownTitle(lines), "Goals +5 · Cards -3");
  assert.equal(breakdownTitle([]), "");
  assert.equal(breakdownTitle(null), "");
});

test("an empty breakdown yields no lines", () => {
  assert.deepEqual(pointsBreakdownLines([]), []);
  assert.deepEqual(pointsBreakdownLines(null), []);
  assert.deepEqual(pointsBreakdownLines([null, {}]), []);
});

// -- storage round trip ------------------------------------------------------

test("scores survive a round trip through the column", () => {
  const scores = new Map([
    [10, { points: 7, breakdown: { goals: 5, appearance: 2 } }],
    [11, { points: 2, breakdown: { appearance: 2 } }],
  ]);
  const rows = parseStoredScores({ matchId: 1, gameweek: 3, scores: serializeScores(scores) });
  assert.equal(rows.length, 2);
  const ten = rows.find((row) => row.playerId === 10);
  assert.deepEqual(ten, { matchId: 1, gameweek: 3, playerId: 10, points: 7, breakdown: { goals: 5, appearance: 2 } });
});

test("a stored blob that cannot be read costs one match, not the whole read", () => {
  assert.deepEqual(parseStoredScores({ matchId: 1, gameweek: 3, scores: "{not json" }), []);
  assert.deepEqual(parseStoredScores({ matchId: 1, gameweek: 3, scores: null }), []);
  assert.deepEqual(parseStoredScores({ matchId: 1, gameweek: 3, scores: "[]" }), []);
  // A single unreadable player entry is skipped, the rest of the match survives.
  const rows = parseStoredScores({
    matchId: 1,
    gameweek: 3,
    scores: JSON.stringify({ 10: { points: 7 }, notanid: { points: 3 }, 12: { points: "abc" } }),
  });
  assert.deepEqual(rows.map((row) => row.playerId), [10]);
});

test("serializing an empty map is still valid JSON", () => {
  assert.equal(serializeScores(new Map()), "{}");
  assert.equal(serializeScores(null), "{}");
});

// -- the label ---------------------------------------------------------------

test("the squad label states live rather than relying on colour", () => {
  assert.deepEqual(squadPointsLabel({ total: 34, provisional: true }), {
    total: 34,
    text: "34 pts",
    provisional: true,
  });
  assert.equal(squadPointsLabel({ total: 34, provisional: false }).provisional, false);
});

test("no points means no label at all, not zero", () => {
  // "0 pts" over an unplayed gameweek is a different claim from showing nothing.
  assert.equal(squadPointsLabel(null), null);
  assert.equal(squadPointsLabel({}), null);
  assert.equal(squadPointsLabel({ total: null }), null);
  // A real zero IS shown: everyone played and nobody scored is worth knowing.
  assert.equal(squadPointsLabel({ total: 0 }).text, "0 pts");
});

// -- the wiring: points actually reach the pitch ------------------------------
// The arithmetic above is pure and easy to test; what breaks in practice is a
// payload field that never gets threaded to the renderer. These drive the real
// panel and assert the numbers appear.

const roster = [
  { id: 4001, name: "Scorer", team: "Arsenal", position: "MID", price: 5 },
  { id: 4002, name: "Skipper", team: "Arsenal", position: "MID", price: 5 },
];

const panelArgs = (points) => ({
  currentGameweek: 1,
  roster,
  lineup: {
    gameweek: 1,
    source: "set",
    starters: [
      { playerId: 4001, isCaptain: false },
      { playerId: 4002, isCaptain: true },
    ],
    bench: [],
    clubFixtures: { Arsenal: 1 },
    points,
  },
  playerPool: [],
  picks: [],
  editState: null,
  drawerPlayerId: null,
  lineupError: "",
  priorSeasonStats: new Map(),
  xpStats: new Map(),
});

test("a live total and a player's points render on the pitch", async () => {
  const { renderFantasyRosterPanel } = await import("../src/fantasyView.js");
  const html = renderFantasyRosterPanel(
    panelArgs({
      total: 14,
      provisional: true,
      players: {
        4001: { points: 8, provisional: true, breakdown: [{ field: "goals", label: "Goals", points: 5 }] },
        4002: { points: 6, provisional: true, breakdown: [] },
      },
    }),
  );
  assert.match(html, /14 pts/);
  assert.match(html, /is-live/, "a provisional total must be marked live");
  assert.match(html, /fantasy-pitch__pts/, "per-player points must render on the tile");
  assert.match(html, /Goals \+5/, "the breakdown must reach the tile's label");
});

test("a settled total renders without the live marker", async () => {
  const { renderFantasyRosterPanel } = await import("../src/fantasyView.js");
  const html = renderFantasyRosterPanel(
    panelArgs({
      total: 14,
      provisional: false,
      players: { 4001: { points: 8, provisional: false, breakdown: [] } },
    }),
  );
  assert.match(html, /14 pts/);
  assert.doesNotMatch(html, /fantasy-pitch__total is-live/);
});

test("no points block renders no points at all, and never throws", async () => {
  // A points read that failed sends null, and the pitch is a squad screen first:
  // the XI must still render, without numbers.
  const { renderFantasyRosterPanel } = await import("../src/fantasyView.js");
  const html = renderFantasyRosterPanel(panelArgs(null));
  assert.match(html, /Scorer/, "the XI must still render");
  assert.doesNotMatch(html, /pts</);
  assert.doesNotMatch(html, /fantasy-pitch__pts/);
});
