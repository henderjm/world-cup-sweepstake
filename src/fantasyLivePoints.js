// Provisional in-match fantasy points.
//
// Until now a player's points existed only once his match was FINISHED:
// runScheduledFantasyScoring filters on isMatchFinished, so during a game the My
// team pitch correctly showed "in play" beside a zero, and a manager watching
// their captain score had nothing to look at. This module is the arithmetic for
// showing those points as they happen.
//
// THE ONE INVARIANT: provisional points are for READING, never for settling.
// The settle path is recomputeFantasyGameweek -> fantasy_gameweek_scores ->
// fantasy_h2h_fixtures, and every one of those rows is permanent history. A
// head-to-head fixture recorded off a match that was still being played would be
// a wrong result that no later tick corrects, because the ledger
// (fantasy_scored_matches) would already say that match was handled. So
// provisional scores live in their own table, are read by their own route, and
// are never handed to the rollup. Nothing here writes.
//
// Points are stored PER MATCH for the same reason settled ones are (see the
// gameweek-window invariant in CLAUDE.md): a club can play twice inside one
// window, and a total is always a SUM. Keying provisional scores on the match
// rather than the player is also what makes the handover safe, because it lets
// the merge below decide per match which source owns it.

// A match is owned by exactly one source. Settled always wins: once
// fantasy_player_match_scores holds a match, its provisional row is stale by
// definition, and counting both would double every point in it. This is the
// whole reason the provisional store is keyed on match_id and not player_id —
// per-player it would be impossible to tell which half to drop.
//
// `settled` and `provisional` are both [{ matchId, playerId, points }]. The
// result is the same shape, ready for sumPlayerPoints, which is still the one
// place accumulation happens.
export function mergeMatchScoreRows({ settled = [], provisional = [] } = {}) {
  const settledMatches = new Set((settled ?? []).map((row) => row?.matchId));
  const live = (provisional ?? []).filter((row) => row && !settledMatches.has(row.matchId));
  return [...(settled ?? []).filter(Boolean), ...live];
}

// Which of a squad's points are still provisional, per player. The pitch needs
// this per player rather than per squad: with a staggered gameweek one starter
// can be finished while another is still on, and marking the whole XI
// provisional would misdescribe both.
export function provisionalPlayerIds(provisionalRows, settledRows) {
  const settledMatches = new Set((settledRows ?? []).map((row) => row?.matchId));
  const ids = new Set();
  for (const row of provisionalRows ?? []) {
    if (!row || row.playerId == null) continue;
    if (settledMatches.has(row.matchId)) continue;
    ids.add(row.playerId);
  }
  return ids;
}

// What earned the points, in the order a reader scans for it: the good news
// first, then the deductions. Keys are the breakdown fields scoreMatchForPlayers
// produces, and the VALUES ARE POINTS, not counts — the scorer adds
// SCORING.goal[position] under "goals", so a 10 there is two midfield goals, not
// ten of them. Labelled accordingly ("Goals +10"), because rendering it as a
// count would be a straightforwardly false statement about the match.
const BREAKDOWN_ORDER = ["goals", "assists", "cleanSheet", "appearance", "cards", "ownGoals"];
const BREAKDOWN_LABELS = Object.freeze({
  goals: "Goals",
  assists: "Assists",
  cleanSheet: "Clean sheet",
  appearance: "Played",
  cards: "Cards",
  ownGoals: "Own goals",
});

// One player's contributions, summed across every match he featured in this
// gameweek and flattened into display order. Zero-valued categories are dropped
// rather than shown as "+0", which is noise on a card that has to fit a pitch.
export function pointsBreakdownLines(breakdowns) {
  const totals = new Map();
  for (const breakdown of breakdowns ?? []) {
    for (const [field, value] of Object.entries(breakdown ?? {})) {
      if (!Number.isFinite(value) || value === 0) continue;
      totals.set(field, (totals.get(field) ?? 0) + value);
    }
  }
  return BREAKDOWN_ORDER.filter((field) => totals.has(field)).map((field) => ({
    field,
    label: BREAKDOWN_LABELS[field],
    points: totals.get(field),
  }));
}

// Parses one stored provisional row's JSON blob into score rows. Defensive
// because it is coming back out of a TEXT column: a row that cannot be read is
// skipped, which costs one match's live points and never breaks the read.
export function parseStoredScores({ matchId, gameweek, scores }) {
  let parsed;
  try {
    parsed = typeof scores === "string" ? JSON.parse(scores) : scores;
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  return Object.entries(parsed).flatMap(([playerId, entry]) => {
    const id = Number(playerId);
    if (!Number.isInteger(id)) return [];
    const points = Number(entry?.points);
    if (!Number.isFinite(points)) return [];
    return [{ matchId, gameweek, playerId: id, points, breakdown: entry?.breakdown ?? {} }];
  });
}

// The inverse, for the cron: scoreMatchForPlayers hands back a Map, and this is
// the JSON that goes in the column. Kept here beside its parser so the two
// cannot drift.
export function serializeScores(scores) {
  const out = {};
  for (const [playerId, entry] of scores ?? []) {
    out[playerId] = { points: entry?.points ?? 0, breakdown: entry?.breakdown ?? {} };
  }
  return JSON.stringify(out);
}

// The pitch head's points line. "Live" is stated in the copy rather than left to
// a colour, because a provisional total is a number somebody will screenshot and
// argue about later, and it can still move: a clean sheet credited at 60 minutes
// is gone by 75 if the goal goes in. Null when there is nothing to show, so the
// caller renders no line at all rather than "0 pts" over an unplayed gameweek.
export function squadPointsLabel(points) {
  if (!points || !Number.isFinite(points.total)) return null;
  return { total: points.total, text: `${points.total} pts`, provisional: Boolean(points.provisional) };
}

// One player's breakdown as a single line, for the tile's tooltip: "Goals +5 ·
// Played +2". Signs are explicit on both directions because a card deduction
// reading "Cards 1" would look like a reward.
export function breakdownTitle(lines) {
  return (lines ?? [])
    .map((line) => `${line.label} ${line.points > 0 ? "+" : ""}${line.points}`)
    .join(" · ");
}
