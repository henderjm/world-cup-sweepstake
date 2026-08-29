// Prediction game: pure scoring, lock and validation logic, shared by the
// Worker and the browser.
//
// The sharing is the point, not a convenience. Anyone can play signed OUT
// (predictions in localStorage, scored client-side against the same feed the
// scoreboard renders), and signed IN the Worker keeps the history and scores
// it in the cron. Those are two different machines scoring the same
// prediction, and they must agree to the point: a visitor who signs in after
// a matchday and watches their 3 become a 1 would rightly call the game
// rigged. One module, imported by both, is how the two verdicts cannot drift.
//
// Scoring is the classic predictor split: the exact scoreline beats the right
// result. EXACT also carries the fantasy hook (issue: "your team earns an
// extra point for each correct score predicted"): each exact prediction adds
// PREDICTION_FANTASY_BONUS to that manager's fantasy gameweek total, folded in
// by recomputeLeagueGameweek (worker/worker.js) at read/rollup time, never
// written to a second table - the bonus is always derivable from the
// prediction rows, so a recompute can only ever converge, exactly like the
// Average opponent and the read-time lineup fallback.
//
// The lock FAILS CLOSED, unlike the fantasy kickoff lock. A wrongly-open
// fantasy lock blocks nobody's exploit (the per-player backstop still holds),
// but a wrongly-open prediction is the whole exploit: predicting a match
// already in play is just reading the scoreboard. So a match with no known
// kickoff, an unparseable one, or any status other than pre-match is not
// predictable, full stop.

export const PREDICTION_POINTS = Object.freeze({
  exact: 3, // predicted the scoreline
  result: 1, // predicted only the outcome (home win / draw / away win)
  miss: 0,
});

// What one exact prediction adds to the predictor's fantasy gameweek score, in
// every league they manage a squad in. A constant here rather than a literal
// in the Worker so the rule reads in one place beside its siblings.
export const PREDICTION_FANTASY_BONUS = 1;

// Goals are capped defensively: the record competitive top-flight score is
// well under this, and an unbounded integer column is an invitation to store
// junk. Both ends validate, so the cap can move without a migration.
export const PREDICTION_MAX_GOALS = 20;

// The two statuses a fixture holds before kickoff. POSTPONED is deliberately
// absent: its kickoff is a fiction until the fixture is rescheduled, and a
// lock computed against a fictional kickoff is not a lock.
const PREDICTABLE_STATUSES = new Set(["TIMED", "SCHEDULED"]);

// "H" / "D" / "A" for a scoreline. The unit both scoring paths compare.
export function predictionOutcome(homeGoals, awayGoals) {
  if (homeGoals > awayGoals) return "H";
  if (homeGoals < awayGoals) return "A";
  return "D";
}

// Validates raw (client-supplied) goals. Returns { ok: true, homeGoals,
// awayGoals } with both coerced to integers, or { ok: false, error }.
// Rejects rather than clamps: a clamped 25 -> 20 silently stores a prediction
// nobody made.
export function validatePredictionInput(input) {
  // Absent before coercion: Number(null) is 0 (the same trap apiBudget.js
  // documents), so a missing field would otherwise validate as a clean sheet.
  if (input?.homeGoals == null || input?.awayGoals == null || input.homeGoals === "" || input.awayGoals === "") {
    return { ok: false, error: "both scores are required" };
  }
  const homeGoals = Number(input.homeGoals);
  const awayGoals = Number(input.awayGoals);
  for (const value of [homeGoals, awayGoals]) {
    if (!Number.isInteger(value)) return { ok: false, error: "goals must be whole numbers" };
    if (value < 0) return { ok: false, error: "goals cannot be negative" };
    if (value > PREDICTION_MAX_GOALS) return { ok: false, error: `goals are capped at ${PREDICTION_MAX_GOALS}` };
  }
  return { ok: true, homeGoals, awayGoals };
}

// Whether a prediction may be made or changed for this match RIGHT NOW.
// Pre-match status AND a known kickoff still ahead of `now`; anything else -
// no match, no kickoff, kickoff passed, live, finished, postponed - is closed.
export function canPredict(match, now = Date.now()) {
  if (!match || !PREDICTABLE_STATUSES.has(match.status)) return false;
  const kickoff = new Date(match.utcDate ?? "").getTime();
  return Number.isFinite(kickoff) && kickoff > now;
}

// Scores one prediction against a final score. Both arguments are plain
// { homeGoals, awayGoals } (already validated integers). Returns
// { points, exact, verdict } where verdict is "exact" | "result" | "miss".
export function scorePrediction(prediction, finalScore) {
  const exact =
    prediction.homeGoals === finalScore.homeGoals && prediction.awayGoals === finalScore.awayGoals;
  if (exact) return { points: PREDICTION_POINTS.exact, exact: true, verdict: "exact" };
  const rightResult =
    predictionOutcome(prediction.homeGoals, prediction.awayGoals) ===
    predictionOutcome(finalScore.homeGoals, finalScore.awayGoals);
  if (rightResult) return { points: PREDICTION_POINTS.result, exact: false, verdict: "result" };
  return { points: PREDICTION_POINTS.miss, exact: false, verdict: "miss" };
}

// Scores a prediction against a mapped feed match, or returns null when the
// match cannot settle a prediction yet: not finished, or finished without
// both final goals present (an AWARDED fixture can arrive scoreless for a
// tick). Null rather than zero, because "not scored yet" and "scored nothing"
// must stay distinguishable - the Worker keys "unscored" on points IS NULL
// and the signed-out view keys it on this returning null.
export function scoreForMatch(prediction, match) {
  if (!match || !isFinishedStatus(match.status)) return null;
  const home = match.score?.home;
  const away = match.score?.away;
  if (!Number.isFinite(home) || !Number.isFinite(away)) return null;
  return scorePrediction(prediction, { homeGoals: home, awayGoals: away });
}

// Local copy of format.js's isFinished. Deliberately duplicated ONE predicate
// rather than importing the whole formatting module into the Worker path for
// two string comparisons; format.js remains the authority and this must match
// it (asserted in test/predictions.test.js).
function isFinishedStatus(status) {
  return status === "FINISHED" || status === "AWARDED";
}

// Rolls a set of SCORED predictions up into the history header numbers.
// Unscored rows (points == null) are ignored rather than counted as misses:
// they are matches that have not finished.
export function summarizePredictions(rows) {
  const summary = { played: 0, exact: 0, result: 0, miss: 0, points: 0 };
  for (const row of rows ?? []) {
    if (row?.points == null) continue;
    summary.played += 1;
    summary.points += row.points;
    if (row.exact) summary.exact += 1;
    else if (row.points > 0) summary.result += 1;
    else summary.miss += 1;
  }
  return summary;
}

// The fantasy bonus a manager earned from `exactCount` exact predictions.
// Trivial on purpose: the rate lives in one exported constant and every
// caller (rollup, matchup, board) goes through here, so the rate can never
// exist in two places.
export function predictionFantasyBonus(exactCount) {
  const count = Number(exactCount);
  if (!Number.isInteger(count) || count <= 0) return 0;
  return count * PREDICTION_FANTASY_BONUS;
}
