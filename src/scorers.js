import { normalizeTeamName } from "./domain.js";

// Golden Boot aggregation. Pure, no DOM and no entrant/owner logic: the view layer adds
// flags and owners. Shared between the build-time fetch script and the browser.

// Goal types that count toward a player's tally. In-play penalties count; own goals
// credit nobody; penalty-shootout kicks do not count. Shootout scores are kept in
// score.penalties, and the type guard prevents any future event-shape drift counting them.
const COUNTING_GOAL_TYPES = new Set(["REGULAR", "PENALTY"]);

// Aggregate goals and assists across mapped match-detail objects (the shape
// mapApiFootballMatchDetail produces). Returns scorers sorted by goal involvements (G+A).
export function aggregateScorers(matchDetails) {
  const players = new Map();

  const credit = (name, team) => {
    const player = String(name ?? "").trim();
    if (!player) return null;
    const teamName = normalizeTeamName(team);
    const key = `${player}__${teamName}`;
    if (!players.has(key)) {
      players.set(key, { player, team: teamName, goals: 0, assists: 0, points: 0 });
    }
    return players.get(key);
  };

  for (const detail of matchDetails ?? []) {
    for (const goal of detail.goals ?? []) {
      if (!COUNTING_GOAL_TYPES.has(goal.type ?? "REGULAR")) continue;
      // The scorer and assister are both on the team credited with the goal.
      const scorer = credit(goal.scorer, goal.team);
      if (scorer) scorer.goals += 1;
      if (goal.assist) {
        const assister = credit(goal.assist, goal.team);
        if (assister) assister.assists += 1;
      }
    }
  }

  const scorers = [...players.values()];
  scorers.forEach((row) => {
    row.points = row.goals + row.assists;
  });
  return scorers.sort(compareByInvolvements);
}

// G+A first (the Golden Boot tab default), then goals, then name.
export function compareByInvolvements(a, b) {
  return b.points - a.points || b.goals - a.goals || a.player.localeCompare(b.player);
}

// Pure goals first (the literal Golden Boot), then assists, then name.
export function compareByGoals(a, b) {
  return b.goals - a.goals || b.assists - a.assists || a.player.localeCompare(b.player);
}
