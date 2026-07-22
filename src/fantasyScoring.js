// Pure fantasy scoring: given one match's mapped API-Football detail, compute each
// involved player's point delta for that match. No DOM, no fetch, no D1 — the Worker's weekly scoring cron and the
// fetch script both call this the same way, feeding matches to whichever store
// they own.
//
// API-Football supplies player minutes. The flat appearance and clean-sheet rule is
// retained from Phase 4.1 until the scoring-engine phase adopts minute thresholds.

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

  // Cards: collapse each player's match events to their strongest outcome. API-
  // Football records a first yellow, second yellow and companion red separately;
  // a dismissal must still score exactly one red-card penalty.
  const cardOutcome = new Map();
  for (const card of detail.cards ?? []) {
    if (card.card === "RED" || card.card === "YELLOW_RED") {
      cardOutcome.set(card.playerId, "RED");
    } else if (card.card === "YELLOW" && !cardOutcome.has(card.playerId)) {
      cardOutcome.set(card.playerId, "YELLOW");
    }
  }
  cardOutcome.forEach((outcome, playerId) => {
    add(playerId, "cards", outcome === "RED" ? SCORING.redCard : SCORING.yellowCard);
  });

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
