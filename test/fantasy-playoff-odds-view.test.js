import assert from "node:assert/strict";
import test from "node:test";

import { roundRobinSchedule } from "../src/draftLogic.js";
import { simulatePlayoffOdds } from "../src/fantasyPlayoffOdds.js";
import { renderFantasyPlayoffOddsPanel } from "../src/fantasyPlayoffOddsView.js";

test("renderFantasyPlayoffOddsPanel shows a loading note before a result exists", () => {
  const html = renderFantasyPlayoffOddsPanel(null);
  assert.match(html, /Loading playoff odds/);
});

test("renderFantasyPlayoffOddsPanel escapes a manager name containing HTML", () => {
  const members = [
    { userId: 1, name: `<script>alert(1)</script>` },
    { userId: 2, name: "Normal Name" },
  ];
  const fixtures = roundRobinSchedule(members.map((m) => m.userId), 10);
  const result = simulatePlayoffOdds({
    members,
    fixtures,
    managers: members.map((m) => ({ userId: m.userId, meanWeeklyPoints: 50 })),
    playoffSpots: 1,
    iterations: 200,
    seed: "view-escape",
  });
  const html = renderFantasyPlayoffOddsPanel(result, {});
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

test("renderFantasyPlayoffOddsPanel marks the viewer's own row and shows clinched/eliminated labels", () => {
  const members = [
    { userId: "A", name: "A" },
    { userId: "B", name: "B" },
    { userId: "C", name: "C" },
  ];
  const decided = [];
  for (let gw = 1; gw <= 10; gw++) decided.push({ gameweek: gw, homeUserId: "A", awayUserId: "B", homeScore: 80, awayScore: 10 });
  const remaining = [{ gameweek: 11, homeUserId: "A", awayUserId: "C" }];
  const result = simulatePlayoffOdds({
    members,
    fixtures: [...decided, ...remaining],
    managers: members.map((m) => ({ userId: m.userId, meanWeeklyPoints: 50 })),
    playoffSpots: 1,
    iterations: 200,
    seed: "view-status",
  });
  const html = renderFantasyPlayoffOddsPanel(result, { myUserId: "B" });
  assert.match(html, /Clinched/);
  assert.match(html, /Eliminated/);
  assert.match(html, /is-me/);
  assert.match(html, /\(you\)/);
});

test("renderFantasyPlayoffOddsPanel explains a league too small for a playoff", () => {
  const members = [1, 2, 3].map((id) => ({ userId: id, name: `M${id}` }));
  const result = simulatePlayoffOdds({ members, fixtures: [], playoffSpots: 4 });
  const html = renderFantasyPlayoffOddsPanel(result, {});
  assert.match(html, /already qualifies/);
  assert.match(html, /100%/);
});

test("renderFantasyPlayoffOddsPanel handles an empty standings list without throwing", () => {
  const html = renderFantasyPlayoffOddsPanel({ standings: [], playoffSpots: 4, tooSmallForPlayoffs: false });
  assert.match(html, /No managers to project/);
});

test("a season with nothing decided says so instead of implying the spread is meaningful", () => {
  const html = renderFantasyPlayoffOddsPanel({
    playoffSpots: 4,
    tooSmallForPlayoffs: false,
    standings: [
      { userId: 1, name: "Alex", played: 0, status: "contention", probability: 0.34 },
      { userId: 2, name: "Sam", played: 0, status: "contention", probability: 0.33 },
    ],
  });
  assert.match(html, /No gameweek has been decided yet/);
  assert.doesNotMatch(html, /Monte Carlo projection over the remaining schedule/);
});

test("once a gameweek is decided the projection note replaces the pre-season caveat", () => {
  const html = renderFantasyPlayoffOddsPanel({
    playoffSpots: 4,
    tooSmallForPlayoffs: false,
    standings: [
      { userId: 1, name: "Alex", played: 3, status: "contention", probability: 0.6 },
      { userId: 2, name: "Sam", played: 3, status: "contention", probability: 0.1 },
    ],
  });
  assert.match(html, /Monte Carlo projection over the remaining schedule/);
  assert.doesNotMatch(html, /No gameweek has been decided yet/);
});
