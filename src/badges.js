import { normalizeTeamName } from "./domain.js";

// Team badge registry, populated from the live feed. The design frames every team
// in a small circular badge: the feed's crest image when we have one, otherwise the
// club's three-letter abbreviation on a colour ring derived from the name, so nothing
// ever renders as a broken image.
const TEAMS = new Map(); // canonical name -> { crest, tla }

export function registerTeams(entries) {
  entries.forEach((info, team) => {
    const key = normalizeTeamName(team);
    const current = TEAMS.get(key) ?? {};
    TEAMS.set(key, {
      crest: info.crest ?? current.crest ?? null,
      tla: info.tla ?? current.tla ?? null,
    });
  });
}

// Three-letter mark for text contexts (ticker) and the no-crest fallback.
export function abbrFor(team) {
  const key = normalizeTeamName(team);
  const known = TEAMS.get(key)?.tla;
  if (known) return known;
  const words = key.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0] + (words[2]?.[0] ?? words[1][1] ?? "")).toUpperCase();
  return key.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase();
}

// Circular team badge. size: "" (22px), "lg" (24px), "xl" (38px, drawer header).
export function badgeFor(team, size = "") {
  const key = normalizeTeamName(team);
  const info = TEAMS.get(key);
  const cls = `tb${size ? ` tb--${size}` : ""}`;
  if (info?.crest) {
    return `<span class="${cls}"><img src="${escapeAttr(info.crest)}" alt="" loading="lazy" onerror="this.parentNode.textContent='${escapeAttr(abbrFor(team))}'" /></span>`;
  }
  return `<span class="${cls}" style="border-color:${ringColor(key)}">${escapeAttr(abbrFor(team))}</span>`;
}

// Stable per-team hue for the abbr fallback ring, so sides stay tellable apart.
function ringColor(name) {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  }
  return `hsl(${hash % 360} 45% 55%)`;
}

function escapeAttr(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}
