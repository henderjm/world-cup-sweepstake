// Pure fantasy scoring: given one match's mapped detail (the shape mapMatchDetail
// produces, see src/mapDetail.js), compute each involved player's point delta for
// that match. No DOM, no fetch, no D1 — the Worker's weekly scoring cron and the
// fetch script both call this the same way, feeding matches to whichever store
// they own.
//
// Approximation, documented: football-data carries no per-player minutes-played
// field, only lineup/bench membership and a flat subs[] list. Appearance and
// clean-sheet credit therefore go to anyone who started or was subbed on, with no
// minutes threshold — see SCORING in src/fantasy.js for the exact rule set.

import { SCORING, bucketPosition } from "./fantasy.js";

// Returns a Map<playerId, { points, breakdown }>. Players who never appear in a
// lineup, bench, goal, card, or sub entry are simply absent from the map — there
// is nothing to score for them.
export function scoreMatchForPlayers(detail) {
  const roster = buildRosterIndex(detail);
  const scores = new Map();

  const add = (playerId, field, amount) => {
    if (playerId == null || !amount) return;
    if (!scores.has(playerId)) {
      scores.set(playerId, { points: 0, breakdown: { goals: 0, assists: 0, cleanSheet: 0, appearance: 0, cards: 0, ownGoals: 0 } });
    }
    const entry = scores.get(playerId);
    entry.breakdown[field] += amount;
    entry.points += amount;
  };

  // Appearance: every starter, plus any bench player who actually came on
  // (per subs[].inId), regardless of minutes played.
  const cameOn = new Set((detail.subs ?? []).map((sub) => sub.inId).filter((id) => id != null));
  roster.forEach((player, playerId) => {
    if (player.started || cameOn.has(playerId)) {
      add(playerId, "appearance", SCORING.appearance);
    }
  });

  // Clean sheet: credited to every player who appeared for a side that
  // conceded zero, position-weighted (FWD gets 0, so this is safe to apply
  // uniformly rather than filtering by position first).
  const homeClean = detail.score?.away === 0;
  const awayClean = detail.score?.home === 0;
  if (Number.isFinite(detail.score?.home) && Number.isFinite(detail.score?.away)) {
    roster.forEach((player, playerId) => {
      const clean = player.side === "home" ? homeClean : awayClean;
      if (!clean) return;
      if (!(player.started || cameOn.has(playerId))) return;
      add(playerId, "cleanSheet", SCORING.cleanSheet[player.position ?? "MID"]);
    });
  }

  // Goals and assists. Own goals penalize the scorer (who sits on the
  // conceding side, not the side credited with the goal) instead of crediting
  // a goal, and never carry an assist.
  for (const goal of detail.goals ?? []) {
    if (goal.type === "OWN") {
      add(goal.scorerId, "ownGoals", SCORING.ownGoal);
      continue;
    }
    const scorerPosition = roster.get(goal.scorerId)?.position ?? "MID";
    add(goal.scorerId, "goals", SCORING.goal[scorerPosition]);
    if (goal.assistId != null) add(goal.assistId, "assists", SCORING.assist);
  }

  // Cards: a second yellow (YELLOW_RED) is scored as the red-card penalty
  // only, matching real fantasy football rules (not -1 then -3 additionally).
  for (const card of detail.cards ?? []) {
    if (card.card === "RED" || card.card === "YELLOW_RED") {
      add(card.playerId, "cards", SCORING.redCard);
    } else if (card.card === "YELLOW") {
      add(card.playerId, "cards", SCORING.yellowCard);
    }
  }

  return scores;
}

// Every player id that appears in either side's lineup or bench, with which
// side they're on, whether they started, and their bucketed position.
function buildRosterIndex(detail) {
  const index = new Map();
  for (const side of ["home", "away"]) {
    const team = detail[side];
    (team?.lineup ?? []).forEach((player) => {
      if (player.id == null) return;
      index.set(player.id, { side, started: true, position: bucketPosition(player.pos) });
    });
    (team?.bench ?? []).forEach((player) => {
      if (player.id == null) return;
      index.set(player.id, { side, started: false, position: bucketPosition(player.pos) });
    });
  }
  return index;
}
