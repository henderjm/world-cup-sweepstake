import { normalizeTeamName } from "./domain.js";

// Team badge registry, populated from the live feed. The design frames every team
// in a small circular badge: a self-hosted crest when we have one, else the feed's
// crest image, else the club's three-letter abbreviation on a colour ring derived
// from the name, so nothing ever renders as a broken image.
const TEAMS = new Map(); // canonical name -> { crest, tla }

// Higher-fidelity crests for the current Premier League, self-hosted so the site
// doesn't depend on a third-party CDN at runtime. Downloaded once from LiveScore
// (storage.livescore.com, "high" tier) into assets/crests/; this is a deliberate,
// documented exception to "never hardcode team images" (see CLAUDE.md) because that
// source has no per-team API of its own. Teams not listed here (new promotions,
// other competitions) fall through to the feed's own crest.
const LOCAL_CRESTS = new Map([
  ["Arsenal", "assets/crests/arsenal.png"],
  ["Aston Villa", "assets/crests/aston-villa.png"],
  ["Bournemouth", "assets/crests/bournemouth.png"],
  ["Brentford", "assets/crests/brentford.png"],
  ["Brighton Hove", "assets/crests/brighton-hove.png"],
  ["Chelsea", "assets/crests/chelsea.png"],
  ["Coventry City", "assets/crests/coventry-city.png"],
  ["Crystal Palace", "assets/crests/crystal-palace.png"],
  ["Everton", "assets/crests/everton.png"],
  ["Fulham", "assets/crests/fulham.png"],
  ["Hull City", "assets/crests/hull-city.png"],
  ["Ipswich Town", "assets/crests/ipswich-town.png"],
  ["Leeds United", "assets/crests/leeds-united.png"],
  ["Liverpool", "assets/crests/liverpool.png"],
  ["Man City", "assets/crests/man-city.png"],
  ["Man United", "assets/crests/man-united.png"],
  ["Newcastle", "assets/crests/newcastle.png"],
  ["Nottingham", "assets/crests/nottingham.png"],
  ["Sunderland", "assets/crests/sunderland.png"],
  ["Tottenham", "assets/crests/tottenham.png"],
]);

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
  const crest = LOCAL_CRESTS.get(key) ?? info?.crest;
  if (crest) {
    return `<span class="${cls}"><img src="${escapeAttr(crest)}" alt="" loading="lazy" onerror="this.parentNode.textContent='${escapeAttr(abbrFor(team))}'" /></span>`;
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
