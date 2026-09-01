import { badgeFor } from "./badges.js";
import { displayTeamName } from "./domain.js";
import { dayLabel, isFinished, isLive, statusLabel, timeLabel } from "./format.js";
import {
  PREDICTION_FANTASY_BONUS,
  PREDICTION_MAX_GOALS,
  PREDICTION_POINTS,
  canPredict,
  scoreForMatch,
  summarizePredictions,
} from "./predictions.js";

// HTML-string renderers for the Predict tab. Pure: the caller (app.js) hands
// in the model, the prediction map (server rows when signed in, the
// localStorage store when not) and the transient input state; nothing here
// fetches or stores. Scoring shown to a signed-out visitor is computed right
// here with the same scoreForMatch the Worker's cron uses, which is the whole
// reason src/predictions.js exists (see its header).

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

// How far ahead the open list looks. The season schedule is 380 fixtures and
// a predictor thinks about this weekend, not May; a fixture beyond the window
// still renders once the visitor has predicted it, so nothing saved ever
// disappears from view.
const OPEN_WINDOW_MS = 10 * 24 * 60 * 60 * 1000;
const MAX_OPEN_ROWS = 40;

const VERDICT_LABELS = {
  exact: `Exact +${PREDICTION_POINTS.exact}`,
  result: `Result +${PREDICTION_POINTS.result}`,
  miss: "Miss +0",
};

function scoredView(prediction, match, signedIn) {
  // Signed in, the Worker's cron verdict on the row is the record; signed out
  // the verdict is computed here from the feed. Same function either way.
  if (signedIn) {
    if (prediction.points == null) return null;
    return {
      points: prediction.points,
      verdict: prediction.exact ? "exact" : prediction.points > 0 ? "result" : "miss",
      actualHome: prediction.actualHome,
      actualAway: prediction.actualAway,
    };
  }
  const verdict = scoreForMatch(prediction, match);
  if (!verdict) return null;
  return { points: verdict.points, verdict: verdict.verdict, actualHome: match.score?.home, actualAway: match.score?.away };
}

function teamSides(match) {
  return {
    home: `<span class="predrow__side predrow__side--h"><span class="predrow__name">${esc(displayTeamName(match.homeTeam))}</span>${badgeFor(match.homeTeam)}</span>`,
    away: `<span class="predrow__side">${badgeFor(match.awayTeam)}<span class="predrow__name">${esc(displayTeamName(match.awayTeam))}</span></span>`,
  };
}

function openRow(match, prediction, draft, savedFlash) {
  const sides = teamSides(match);
  const homeValue = draft?.home ?? (prediction ? String(prediction.homeGoals) : "");
  const awayValue = draft?.away ?? (prediction ? String(prediction.awayGoals) : "");
  const input = (side, value) =>
    `<input class="pred-input" type="number" min="0" max="${PREDICTION_MAX_GOALS}" inputmode="numeric" aria-label="${side} goals" data-predict-${side}="${match.id}" value="${esc(value)}">`;
  return `<div class="predrow" data-predict-row="${match.id}">
      <div class="predrow__teams">
        ${sides.home}
        <span class="predrow__inputs">${input("home", homeValue)}<span class="predrow__dash">–</span>${input("away", awayValue)}</span>
        ${sides.away}
      </div>
      <div class="predrow__meta">
        <span class="predrow__ko">${timeLabel(match.utcDate)}</span>
        <button class="btn predrow__save" type="button" data-predict-save="${match.id}">${prediction ? "Update" : "Save"}</button>
        <span class="predrow__note" data-predict-note="${match.id}">${savedFlash ? "Saved ✓" : prediction ? "Locked at kick-off" : ""}</span>
      </div>
    </div>`;
}

function pendingRow(match, prediction) {
  const sides = teamSides(match);
  const live = isLive(match.status);
  const current =
    Number.isFinite(match.score?.home) && Number.isFinite(match.score?.away)
      ? `${match.score.home}–${match.score.away}`
      : "0–0";
  return `<div class="predrow predrow--locked">
      <div class="predrow__teams">
        ${sides.home}
        <span class="predrow__pick"><span class="predrow__pickscore">${prediction.homeGoals}–${prediction.awayGoals}</span><span class="predrow__picklabel">your call</span></span>
        ${sides.away}
      </div>
      <div class="predrow__meta">
        <span class="predrow__ko ${live ? "is-live" : ""}">${esc(statusLabel(match))}</span>
        <span class="predrow__note">${live ? `now ${current}` : isFinished(match.status) ? "scoring shortly" : "locked"}</span>
      </div>
    </div>`;
}

function resultRow(match, prediction, scored) {
  const sides = teamSides(match);
  return `<div class="predrow predrow--done">
      <div class="predrow__teams">
        ${sides.home}
        <span class="predrow__pick"><span class="predrow__pickscore">${scored.actualHome}–${scored.actualAway}</span><span class="predrow__picklabel">you said ${prediction.homeGoals}–${prediction.awayGoals}</span></span>
        ${sides.away}
      </div>
      <div class="predrow__meta">
        <span class="predchip predchip--${scored.verdict}">${VERDICT_LABELS[scored.verdict]}</span>
      </div>
    </div>`;
}

function groupByDay(rows) {
  const byDay = new Map();
  for (const { match, html } of rows) {
    const day = dayLabel(match.utcDate);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(html);
  }
  return [...byDay.entries()]
    .map(([day, htmls]) => `<section class="fxday"><h3>${day}</h3><div class="fxday__card">${htmls.join("")}</div></section>`)
    .join("");
}

function summaryChips(summary) {
  if (!summary || !summary.played) return "";
  return `<div class="predsummary">
      <span class="predchip predchip--points">${summary.points} pts</span>
      <span class="predchip predchip--exact">${summary.exact} exact</span>
      <span class="predchip">${summary.result} results</span>
      <span class="predchip">${summary.played} scored</span>
    </div>`;
}

// The whole Predict panel.
//   model        - the app model (matches for the ACTIVE competition)
//   signedIn     - session present; predictions/serverSummary come from the Worker
//   available    - Worker origin configured at all (persistence possible)
//   predictions  - Map matchId -> { homeGoals, awayGoals, points, exact, actualHome, actualAway }
//   serverSummary- the Worker's all-competition summary (signed in only)
//   drafts       - Map matchId -> { home, away } unsaved input text to survive re-renders
//   saved        - Set of matchIds saved this session, for the row's "Saved" flash
//   loading/error- signed-in history fetch state
export function renderPredictPanel({
  model,
  signedIn,
  available,
  predictions,
  serverSummary = null,
  drafts = new Map(),
  saved = new Set(),
  loading = false,
  error = null,
  now = Date.now(),
}) {
  const matches = model?.matches ?? [];
  const matchById = new Map(matches.map((match) => [match.id, match]));

  const openMatches = matches
    .filter((match) => canPredict(match, now))
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate))
    .filter(
      (match) => predictions.has(match.id) || new Date(match.utcDate).getTime() - now <= OPEN_WINDOW_MS,
    )
    .slice(0, MAX_OPEN_ROWS);

  const pending = [];
  const results = [];
  for (const [matchId, prediction] of predictions) {
    const match = matchById.get(matchId);
    if (!match || canPredict(match, now)) continue;
    const scored = scoredView(prediction, match, signedIn);
    if (scored) results.push({ match, html: resultRow(match, prediction, scored) });
    else pending.push({ match, html: pendingRow(match, prediction) });
  }
  pending.sort((a, b) => new Date(a.match.utcDate) - new Date(b.match.utcDate));
  results.sort((a, b) => new Date(b.match.utcDate) - new Date(a.match.utcDate));

  // Signed out, the header numbers are the rows on screen; signed in they are
  // the Worker's own rollup, which also covers competitions not currently
  // selected (the note below the chips says so).
  const summary = signedIn
    ? serverSummary
    : summarizePredictions(
        [...predictions.entries()].map(([matchId, prediction]) => {
          const scored = scoredView(prediction, matchById.get(matchId), false);
          return scored ? { points: scored.points, exact: scored.verdict === "exact" } : { points: null };
        }),
      );

  const persistenceNote = signedIn
    ? "Your predictions and score history are saved to your account."
    : available
      ? `You're playing on this device. Sign in (You tab) to keep your history${PREDICTION_FANTASY_BONUS ? " and earn fantasy bonus points" : ""}.`
      : "You're playing on this device.";

  const openBody = openMatches.length
    ? groupByDay(openMatches.map((match) => ({
        match,
        html: openRow(match, predictions.get(match.id) ?? null, drafts.get(match.id), saved.has(match.id)),
      })))
    : `<p class="note">No fixtures are open for predictions right now. More open as kick-offs approach.</p>`;

  return `
    <div class="predict">
      <div class="predict__intro">
        <h2 class="predict__title">Predict the scores</h2>
        <p class="note">Call the final score of any upcoming fixture before kick-off: <strong>${PREDICTION_POINTS.exact} points</strong> for the exact score, <strong>${PREDICTION_POINTS.result}</strong> for the right result. ${esc(persistenceNote)}</p>
        <p class="note predict__fantasy">Play Fantasy too? Every exact score adds <strong>+${PREDICTION_FANTASY_BONUS} point</strong> to your fantasy team's gameweek total.</p>
        ${signedIn && loading ? `<p class="note">Loading your prediction history…</p>` : ""}
        ${signedIn && error ? `<p class="note">Couldn't load your saved predictions (${esc(error)}); showing the fixtures anyway.</p>` : ""}
      </div>
      ${summaryChips(summary)}
      ${signedIn && summary?.played && results.length < summary.played ? `<p class="note">Totals cover every competition; the rows below are ${esc(model?.competition?.name ?? "this competition")}.</p>` : ""}
      <h3 class="predict__heading">Open for predictions</h3>
      ${openBody}
      ${pending.length ? `<h3 class="predict__heading">Waiting on the whistle</h3>${groupByDay(pending)}` : ""}
      ${results.length ? `<h3 class="predict__heading">Your results</h3>${groupByDay(results)}` : ""}
    </div>`;
}
