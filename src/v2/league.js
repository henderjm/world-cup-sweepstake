// Pure view logic for the V2 league page (#league/<CODE>/<tab>): routing,
// and splitting a competition's matches into Fixtures and Results. No DOM,
// no fetch. The page shows only what the feed holds; it never pads a
// fixture list or invents a result.

import { COMPETITIONS } from "../competitions.js";
import { isFinished } from "../format.js";
import { localDateKey } from "../scoreDates.js";

export const LEAGUE_TABS = [
  { key: "table", label: "Table" },
  { key: "fixtures", label: "Fixtures" },
  { key: "results", label: "Results" },
  { key: "stats", label: "Stats" },
];
const TAB_KEYS = new Set(LEAGUE_TABS.map(tab => tab.key));

// "#match/123", "#league/PL", "#league/PL/results", "#league/PL/results/match/123",
// or a section ("#fantasy"). Unknown competitions and tabs fall back rather
// than rendering an empty page.
export function parseRoute(hash, sections = ["live"]) {
  const raw = String(hash ?? "").replace(/^#/, "");
  const match = /^match\/(\d+)$/.exec(raw);
  if (match) return { section: "live", league: null, tab: null, matchId: match[1] };
  const league = /^league\/([A-Za-z]{2,6})(?:\/([a-z]+))?(?:\/match\/(\d+))?$/.exec(raw);
  if (league && COMPETITIONS[league[1].toUpperCase()]) {
    return {
      section: "live",
      league: league[1].toUpperCase(),
      tab: TAB_KEYS.has(league[2]) ? league[2] : "table",
      matchId: league[3] ?? null,
    };
  }
  const section = raw.split("/")[0];
  return { section: sections.includes(section) ? section : "live", league: null, tab: null, matchId: null };
}

export function leagueHash(code, tab = "table", matchId = null) {
  return `#league/${code}${tab && tab !== "table" ? `/${tab}` : ""}${matchId == null ? "" : `/match/${matchId}`}`;
}

// The hash a route sits on with no match open: where closing a match returns.
export function routeBase(route) {
  return route?.league ? leagueHash(route.league, route.tab) : "#live";
}

const byKickoff = (a, b) => new Date(a.utcDate) - new Date(b.utcDate) || String(a.homeTeam).localeCompare(String(b.homeTeam));

// Everything still to be decided (upcoming, live, postponed), soonest first.
export function leagueFixtures(matches) {
  return (matches ?? []).filter(match => match.utcDate && !isFinished(match.status)).sort(byKickoff);
}

// Finished matches, most recent first.
export function leagueResults(matches) {
  return (matches ?? []).filter(match => match.utcDate && isFinished(match.status)).sort((a, b) => byKickoff(b, a));
}

// [{ day, matches }] in the order given, one group per local calendar day.
export function groupByDay(matches) {
  const groups = [];
  for (const match of matches ?? []) {
    const day = localDateKey(match.utcDate);
    const last = groups.at(-1);
    if (last?.day === day) last.matches.push(match);
    else groups.push({ day, matches: [match] });
  }
  return groups;
}

// The first `count` day groups, and whether more remain: long seasons are
// revealed a few matchdays at a time rather than 380 rows at once.
export function firstDays(groups, count) {
  return { shown: groups.slice(0, count), more: groups.length > count };
}
