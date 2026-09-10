// UEFA 2026/27 Article 18. Published ranks remain authoritative when later
// criteria (notably disciplinary points and coefficients) are unavailable.
export function rankChampionsLeagueRows(rows, matches = []) {
  const byTeam = new Map(rows.map(row => [row.team, row]));
  const opponents = new Map(rows.map(row => [row.team, new Set()]));
  for (const match of matches) {
    if (match.stage !== "LEAGUE_STAGE") continue;
    if (!byTeam.has(match.homeTeam) || !byTeam.has(match.awayTeam)) continue;
    opponents.get(match.homeTeam).add(match.awayTeam);
    opponents.get(match.awayTeam).add(match.homeTeam);
  }
  const complete = rows.every(row => row.played === 8 && opponents.get(row.team).size === 8);
  const opponentTotal = (row, field) => complete
    ? [...opponents.get(row.team)].reduce((sum, team) => sum + byTeam.get(team)[field], 0)
    : null;
  const criteria = [
    row => row.points,
    row => row.goalDifference,
    row => row.goalsFor,
    row => row.awayGoals,
    row => row.won,
    row => row.awayWins,
    row => opponentTotal(row, "points"),
    row => opponentTotal(row, "goalDifference"),
    row => opponentTotal(row, "goalsFor"),
  ];
  let incomplete = false;
  // Refine whole tied groups: pairwise missing-value fallbacks can produce a
  // non-transitive comparator and arbitrarily reorder three or more clubs.
  const refine = (group, index) => {
    if (group.length < 2) return group;
    if (index === criteria.length || group.some(row => !Number.isFinite(criteria[index](row)))) {
      incomplete = true;
      return group;
    }
    const value = criteria[index];
    const sorted = [...group].sort((a, b) => value(b) - value(a));
    const result = [];
    for (let start = 0; start < sorted.length;) {
      let end = start + 1;
      while (end < sorted.length && value(sorted[end]) === value(sorted[start])) end += 1;
      result.push(...refine(sorted.slice(start, end), index + 1));
      start = end;
    }
    return result;
  };
  return {
    rows: refine([...rows].sort((a, b) => a.position - b.position), 0),
    incomplete,
  };
}
