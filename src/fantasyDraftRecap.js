// Post-draft grades: the NUMBERS half.
//
// Yahoo surfaces a draft recap from the whistle until kickoff and has upgraded
// its AI for it; ESPN ships one too; no football draft platform has one at all.
// It is the highest-emotion moment of the season and the one a manager is most
// likely to screenshot into a group chat, which is why it exists here.
//
// Same split as the weekly recap (src/fantasyRecap.js + fantasyRecapPrompt.js),
// and for the same hard-won reason: EVERY FIGURE A READER SEES IS COMPUTED
// HERE. The model is handed these numbers and writes only connective prose. A
// bland recap is forgiven; a confidently wrong one is not, and a grade is
// exactly the kind of number a reader will argue with and then check.
//
// This module defines NO new notion of player value. Value over replacement
// already exists once, in src/fantasyDraftRank.js, and it is the same board the
// draft room showed managers while they were picking. Grading against a second
// definition would mean telling somebody they reached for a player the app had
// just recommended to them.
//
// Pure: no DOM, no fetch, no D1, no clock. Same contract as the rest of
// src/fantasy*.js.

import { STARTING_LIMITS } from "./fantasy.js";
import { bestStartingXi } from "./fantasyLineups.js";
import { rankDraftPool } from "./fantasyDraftRank.js";
import { median } from "./fantasyRecap.js";
import { PICK_VIA } from "./draftLogic.js";

// The grading curve's minimum spread, in expected-points units.
//
// Grading purely on the league's own standard deviation is right when the
// drafts genuinely differed and absurd when they did not: in a two-manager
// league the two z-scores are always exactly +1 and -1, so a draft decided by
// three points would manufacture an A and an F. Flooring the scale means a
// league that drafted evenly grades evenly (everyone lands mid-table C), and
// the curve only takes over once the real spread exceeds the floor.
export const GRADE_SCALE_FLOOR = 8;

// Bands on the floored z-score, best first. Deliberately generous in the
// middle: the interesting signal is the tails (who nailed it, who did not),
// and a five-way forced ranking would hand somebody an F in a league where
// everybody drafted competently.
export const GRADE_BANDS = Object.freeze([
  { grade: "A", min: 1.0 },
  { grade: "B", min: 0.35 },
  { grade: "C", min: -0.35 },
  { grade: "D", min: -1.0 },
]);
export const LOWEST_GRADE = "F";

// A position counts as a strength or a hole against what the REST OF THIS
// LEAGUE managed at the same position, never against an absolute number: a
// league where nobody took a striker early has no holes at forward, it has a
// different market.
export const STRENGTH_RATIO = 1.1;
export const HOLE_RATIO = 0.9;

export function gradeFromZ(z) {
  if (!Number.isFinite(z)) return "C"; // unmeasurable, not bad
  for (const band of GRADE_BANDS) {
    if (z >= band.min) return band.grade;
  }
  return LOWEST_GRADE;
}

// How far a player lasted past his own board rank, measured in draft slots.
//
// POSITIVE IS VALUE: the manager spent a later pick than the board said he was
// worth, so taking the 5th ranked player at pick 20 is +15. Negative is a
// reach: taking the 101st ranked player at pick 1 is -100.
//
// Null when the player has no board rank at all (no xP), because "he was not
// on the board" is not a reach and must not be reported as the deepest one.
export function pickDelta(overallPick, draftRank) {
  if (!Number.isFinite(draftRank) || !Number.isFinite(overallPick)) return null;
  return overallPick - draftRank;
}

// What a manager can actually put on the pitch at one position: the xP of the
// best players they hold there, counted to that position's STARTING_LIMITS
// MINIMUM (the number they are obliged to start every week). Depth beyond the
// minimum is real but it is bench cover, not a starting strength, and counting
// it would let five good midfielders paper over having no goalkeeper.
export function positionStartingPoints(roster, position) {
  const required = STARTING_LIMITS[position]?.min ?? 0;
  const best = (roster ?? [])
    .filter((player) => player?.position === position)
    .sort((a, b) => xpOf(b) - xpOf(a))
    .slice(0, required);
  return round1(best.reduce((sum, player) => sum + xpOf(player), 0));
}

// Strength, solid or hole, against this league's own median at that position.
export function positionVerdict(points, leagueMedian) {
  if (!Number.isFinite(leagueMedian) || leagueMedian <= 0) return "solid";
  if (points >= leagueMedian * STRENGTH_RATIO) return "strength";
  if (points <= leagueMedian * HOLE_RATIO) return "hole";
  return "solid";
}

// Was this manager actually AT their draft? Reads fantasy_draft_picks.via
// (PICK_VIA in src/draftLogic.js).
//
// A bot seat returns null rather than a rate: its clock always expires by
// design, so any percentage computed for it would be a statement about the
// product's own behaviour dressed up as a statement about a manager. Callers
// must render null as "not applicable", never as zero.
export function managerEngagement(picks, isBot) {
  if (isBot) return null;
  const known = (picks ?? []).filter((pick) => pick.via != null && pick.via !== PICK_VIA.BOT);
  if (!known.length) return null; // picks predate the column; unmeasured, not absent
  const chosen = known.filter((pick) => pick.via === PICK_VIA.MANUAL).length;
  const queued = known.filter((pick) => pick.via === PICK_VIA.QUEUE).length;
  return {
    picks: known.length,
    manual: chosen,
    queue: queued,
    autopick: known.length - chosen - queued,
    engagedPct: Math.round((100 * (chosen + queued)) / known.length),
  };
}

// The whole recap's numbers, one entry per manager.
//
// `players` is the draft pool carrying an `xp` per player; `picks` is the
// league's pick log in any order. Nothing here reads a clock or a database, so
// the same inputs always produce the same recap.
export function buildDraftRecap({ managers, picks, players }) {
  const roster = managers ?? [];
  const leagueSize = roster.length;
  if (leagueSize < 2) return { leagueSize, teams: [] };

  // The same board, computed the same way, that the draft room showed these
  // managers while they were picking. Replacement level depends on league size,
  // which is why it is computed here rather than baked into the pool.
  const board = rankDraftPool(players ?? [], leagueSize);
  const boardById = new Map(board.map((player) => [player.id, player]));

  const picksByManager = new Map(roster.map((manager) => [manager.userId, []]));
  for (const pick of [...(picks ?? [])].sort((a, b) => a.overallPick - b.overallPick)) {
    picksByManager.get(pick.userId)?.push(pick);
  }

  // Stage one: the raw per-manager figures. The grade needs the whole league's
  // spread, so it cannot be assigned until every manager has been measured.
  const measured = roster.map((manager) => {
    const own = picksByManager.get(manager.userId) ?? [];
    const squad = own.map((pick) => boardById.get(pick.playerId)).filter(Boolean);

    const squadValue = sum(squad.map((player) => player.vor ?? 0));
    // What the board says these exact draft slots were worth. Subtracting it is
    // what neutralises draft-slot luck: picking first is an advantage the
    // manager did not earn, and grading without this would hand it to them.
    const slotValue = sum(own.map((pick) => board[pick.overallPick - 1]?.vor ?? 0));

    const deltas = own
      .map((pick) => {
        const player = boardById.get(pick.playerId);
        const delta = pickDelta(pick.overallPick, player?.draftRank);
        return delta == null ? null : { pick, player, delta };
      })
      .filter(Boolean);

    return {
      manager,
      picks: own,
      squad,
      valueOverSlots: round1(squadValue - slotValue),
      bestValue: pickHighlight(deltas, (a, b) => b.delta - a.delta),
      biggestReach: pickHighlight(deltas, (a, b) => a.delta - b.delta),
      projected: bestStartingXi(squad),
      positionPoints: Object.fromEntries(
        Object.keys(STARTING_LIMITS).map((position) => [position, positionStartingPoints(squad, position)]),
      ),
      engagement: managerEngagement(own, manager.isBot),
    };
  });

  // Stage two: the two league-wide comparisons. Every manager's grade is
  // relative to the league's own spread, and every positional verdict to the
  // league's own median at that position.
  const values = measured.map((entry) => entry.valueOverSlots);
  const mean = values.reduce((total, value) => total + value, 0) / leagueSize;
  const scale = Math.max(standardDeviation(values, mean), GRADE_SCALE_FLOOR);
  const medians = Object.fromEntries(
    Object.keys(STARTING_LIMITS).map((position) => [
      position,
      median(measured.map((entry) => entry.positionPoints[position])),
    ]),
  );

  const finishOrder = [...measured].sort((a, b) => b.projected.points - a.projected.points);
  const finishByUser = new Map(finishOrder.map((entry, index) => [entry.manager.userId, index + 1]));

  const teams = measured.map((entry) => ({
    userId: entry.manager.userId,
    name: entry.manager.name,
    isBot: Boolean(entry.manager.isBot),
    grade: gradeFromZ((entry.valueOverSlots - mean) / scale),
    valueOverSlots: entry.valueOverSlots,
    bestValue: highlightPayload(entry.bestValue),
    biggestReach: highlightPayload(entry.biggestReach),
    positions: Object.keys(STARTING_LIMITS).map((position) => ({
      position,
      startersRequired: STARTING_LIMITS[position].min,
      points: entry.positionPoints[position],
      leagueMedian: round1(medians[position] ?? 0),
      verdict: positionVerdict(entry.positionPoints[position], medians[position]),
    })),
    projectedPoints: entry.projected.points,
    projectedFinish: finishByUser.get(entry.manager.userId) ?? null,
    engagement: entry.engagement,
  }));

  // Ordered by the grade the reader cares about most, which is the projection,
  // so the payload renders top-down without the view re-sorting it.
  teams.sort((a, b) => (a.projectedFinish ?? Infinity) - (b.projectedFinish ?? Infinity));
  return { leagueSize, teams };
}

// One line worth pasting into a group chat, composed from the numbers above and
// nothing the model wrote. Deliberately carries no invite code and no league
// id: this is shared OUTWARDS, and a link that joins the sender's private
// league is not a thing to hand to a group chat by accident.
export function composeDraftShareText(team, leagueSize, link) {
  if (!team) return "";
  const value = team.bestValue ? ` Steal of the draft: ${team.bestValue.name}.` : "";
  return (
    `Graded ${team.grade} in my Kickoff Draft league, projected to finish ` +
    `${team.projectedFinish} of ${leagueSize} on ${team.projectedPoints} points.${value} ` +
    `Draft your own: ${link}`
  );
}

function pickHighlight(deltas, compare) {
  if (!deltas.length) return null;
  return [...deltas].sort(compare)[0];
}

function highlightPayload(entry) {
  if (!entry) return null;
  return {
    playerId: entry.player.id,
    name: entry.player.name,
    team: entry.player.team,
    position: entry.player.position,
    overallPick: entry.pick.overallPick,
    round: entry.pick.round,
    draftRank: entry.player.draftRank,
    // Slots of value: positive means he lasted past his board rank, negative
    // means he was taken ahead of it. Signed rather than split into two fields
    // so both highlights share one shape and a renderer formats them
    // identically.
    slots: entry.delta,
  };
}

function xpOf(player) {
  const value = Number(player?.xp);
  return Number.isFinite(value) ? value : 0;
}

function sum(values) {
  return values.reduce((total, value) => total + (Number(value) || 0), 0);
}

function standardDeviation(values, mean) {
  if (values.length < 2) return 0;
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function round1(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}
