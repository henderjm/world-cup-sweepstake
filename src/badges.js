import { normalizeTeamName } from "./domain.js";

// Club crest lookup, populated from the live feed (football-data serves a crest URL
// per team). The registry survives re-registration across polls, so a team seen once
// keeps its crest even if a later payload omits it. Fallback is a neutral ball so
// nothing ever renders as a broken image.
const CRESTS = new Map();

export function registerCrests(entries) {
  entries.forEach((url, team) => {
    if (url) CRESTS.set(normalizeTeamName(team), url);
  });
}

export function badgeFor(team) {
  const url = CRESTS.get(normalizeTeamName(team));
  if (!url) return "⚽";
  return `<img class="crest" src="${escapeAttr(url)}" alt="" loading="lazy" onerror="this.style.display='none'" />`;
}

function escapeAttr(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  })[char]);
}
