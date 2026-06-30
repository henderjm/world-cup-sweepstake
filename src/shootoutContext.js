import { ENTRANTS } from "./data.js";
import { normalizeTeamName } from "./domain.js";
import { seededRandom } from "./shootoutModel.js";

// Cosmetic only. If the entered name matches a sweepstake entrant, return one of
// their teams as flavour for the result and share card. It never affects the
// keeper, the shot, or difficulty. Returns null when the name is not an entrant.
export function cosmeticTeamForName(name) {
  const entrant = findEntrant(name);
  if (!entrant || !entrant.teams?.length) return null;
  // Stable per name so the same player always gets the same flavour team.
  const rng = seededRandom(`shootout-team:${entrant.name}`);
  const team = entrant.teams[Math.floor(rng() * entrant.teams.length)];
  return normalizeTeamName(team);
}

function findEntrant(name) {
  const needle = String(name ?? "").trim().toLowerCase();
  if (!needle) return null;
  return ENTRANTS.find((entrant) => entrant.name.trim().toLowerCase() === needle) ?? null;
}
