import test from "node:test";
import assert from "node:assert/strict";

import { renderPredictPanel } from "../src/predictionsView.js";

const NOW = Date.parse("2026-08-29T10:00:00Z");
const model = {
  competition: { name: "Premier League" },
  matches: [
    { id: 1, status: "TIMED", utcDate: "2026-08-29T14:00:00Z", homeTeam: "Arsenal", awayTeam: "Chelsea", score: {} },
    { id: 2, status: "IN_PLAY", utcDate: "2026-08-29T09:00:00Z", homeTeam: "Everton", awayTeam: "Fulham", score: { home: 1, away: 0 }, minute: 38 },
    { id: 3, status: "FINISHED", utcDate: "2026-08-22T14:00:00Z", homeTeam: "Leeds United", awayTeam: "Hull City", score: { home: 2, away: 2 } },
    // Beyond the open window and unpredicted: must not render a row.
    { id: 4, status: "TIMED", utcDate: "2026-12-01T15:00:00Z", homeTeam: "Brighton", awayTeam: "Chelsea", score: {} },
  ],
};

const baseArgs = { model, signedIn: false, available: true, now: NOW };

test("signed out: open fixture renders inputs, live one waits, finished one scores locally", () => {
  const predictions = new Map([
    [1, { homeGoals: 2, awayGoals: 1, points: null, exact: null }],
    [2, { homeGoals: 1, awayGoals: 0, points: null, exact: null }],
    [3, { homeGoals: 2, awayGoals: 2, points: null, exact: null }],
  ]);
  const html = renderPredictPanel({ ...baseArgs, predictions });
  assert.match(html, /data-predict-save="1"/);
  assert.match(html, /Waiting on the whistle/);
  assert.match(html, /now 1–0/);
  // The finished 2-2 scores EXACT client-side with no server involved.
  assert.match(html, /Your results/);
  assert.match(html, /Exact \+3/);
  assert.match(html, /3 pts/);
  // The far-future unpredicted fixture stays out of the open list.
  assert.doesNotMatch(html, /data-predict-save="4"/);
});

test("a prediction on a far-future fixture keeps its row despite the window", () => {
  const predictions = new Map([[4, { homeGoals: 0, awayGoals: 0, points: null, exact: null }]]);
  const html = renderPredictPanel({ ...baseArgs, predictions });
  assert.match(html, /data-predict-save="4"/);
});

test("signed in: verdicts come from the server rows, not local scoring", () => {
  const predictions = new Map([
    [3, { homeGoals: 1, awayGoals: 1, points: 1, exact: false, actualHome: 2, actualAway: 2 }],
  ]);
  const html = renderPredictPanel({
    ...baseArgs,
    signedIn: true,
    predictions,
    serverSummary: { played: 1, exact: 0, result: 1, miss: 0, points: 1 },
  });
  assert.match(html, /Result \+1/);
  assert.match(html, /you said 1–1/);
  assert.match(html, /saved to your account/);
});

test("signed in with an unscored finished match waits rather than inventing a verdict", () => {
  const predictions = new Map([[3, { homeGoals: 2, awayGoals: 2, points: null, exact: null }]]);
  const html = renderPredictPanel({ ...baseArgs, signedIn: true, predictions });
  assert.match(html, /scoring shortly/);
  assert.doesNotMatch(html, /Exact \+3/);
});

test("drafts prefill inputs ahead of the saved prediction and empty state renders a note", () => {
  const withDraft = renderPredictPanel({
    ...baseArgs,
    predictions: new Map([[1, { homeGoals: 0, awayGoals: 0, points: null, exact: null }]]),
    drafts: new Map([[1, { home: "3", away: "1" }]]),
  });
  assert.match(withDraft, /data-predict-home="1" value="3"/);
  const empty = renderPredictPanel({
    ...baseArgs,
    model: { competition: model.competition, matches: [] },
    predictions: new Map(),
  });
  assert.match(empty, /No fixtures are open/);
});

test("team names are escaped", () => {
  const spiky = {
    competition: { name: "PL" },
    matches: [
      { id: 9, status: "TIMED", utcDate: "2026-08-29T14:00:00Z", homeTeam: `<img src=x onerror=alert(1)>`, awayTeam: "B", score: {} },
    ],
  };
  const html = renderPredictPanel({ ...baseArgs, model: spiky, predictions: new Map() });
  assert.doesNotMatch(html, /<img src=x/);
});
