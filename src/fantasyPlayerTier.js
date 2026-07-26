// Pure logic for the fantasy draft pool's likely-first-teamer signal. Season
// appearance data alone tells us nothing without a rule for turning it into an
// ordering; that rule lives here, isolated from the fetch script, so it is
// fixture-testable without an API-Football key.
//
// Why a previous-season proxy: a brand-new season's appearance data is all
// zeros until matches are actually played, which is useless as a "does this
// player actually play" signal in preseason. The previous completed season's
// minutes are the best available proxy, so `previousSeasonFor` derives it from
// whatever season the rest of the fetch is already using rather than a
// hardcoded year, and stays correct as seasons roll forward.

// Roughly ten full matches: enough to call someone an established starter
// without requiring an implausible ever-present season.
const STARTER_MINUTES_THRESHOLD = 900;

// Ordering used to sort the pool. A missing prior-season record ("unknown")
// ranks above "fringe" on purpose: a zero-minutes record is *evidence* a
// player didn't play, while no record at all is simply no evidence either
// way (a new signing, a promoted club's player, a genuine academy prospect).
// Treating "no evidence" as worse than "evidence of not playing" would bury
// good new signings, which is exactly the failure mode we're avoiding.
export const TIER_ORDER = ["starter", "squad", "unknown", "fringe"];
const TIER_RANK = Object.fromEntries(TIER_ORDER.map((tier, index) => [tier, index]));

// Given the previous season's { appearances, minutes } for a player (or
// null/undefined when no record was found at all), derive a coarse tier:
//   - "unknown": no prior-season record exists. Not a judgement, just a gap.
//   - "starter": played substantial minutes last season, a likely first-teamer.
//   - "squad": has some prior-season minutes/appearances, but below the
//     starter threshold, e.g. a rotation option or a squad player who
//     started to break through.
//   - "fringe": has a prior-season record but zero recorded minutes, e.g. a
//     third-choice keeper who was registered all season but never played.
export function deriveTier(stat) {
  if (stat == null) return "unknown";
  const minutes = Number(stat.minutes) || 0;
  const appearances = Number(stat.appearances) || 0;
  if (minutes >= STARTER_MINUTES_THRESHOLD) return "starter";
  if (minutes > 0 || appearances > 0) return "squad";
  return "fringe";
}

// Derives the previous-season identifier from whatever season string/number
// the rest of the fetch is configured with (API-Football seasons are named by
// their starting year), rather than a hardcoded guess that would go stale.
export function previousSeasonFor(season) {
  const year = Number(season);
  if (!Number.isInteger(year)) throw new Error(`invalid season: ${season}`);
  return String(year - 1);
}

// Stable-sorts a player pool so likely first-teamers surface first. Safe to
// call even when no player carries a `tier` (the pre-enrichment/degraded
// shape): every entry then ranks equally and the original order is preserved,
// since Array#sort is a stable sort.
export function sortPlayerPool(players) {
  return [...(players ?? [])].sort((a, b) => (TIER_RANK[a?.tier] ?? 0) - (TIER_RANK[b?.tier] ?? 0));
}

// Parses the raw API-Football /players payload pages (each `{ response: [...] }`,
// as returned by the Go CLI) into a Map<playerId, { appearances, minutes }>,
// summing across any repeated rows for the same player (a mid-season transfer
// can produce one row per club) and across duplicate rows across pages.
// Filtered to the requested league id defensively, even though the upstream
// query already scopes to one league, in case a player's statistics entry
// carries a different competition (API-Football's `statistics` array is not
// contractually guaranteed to be pre-filtered).
//
// Note the upstream field is spelled "appearences" (an API-Football quirk),
// not the standard English spelling; both are accepted defensively.
export function buildPriorSeasonStatsIndex(pages, leagueId) {
  const index = new Map();
  for (const page of pages ?? []) {
    for (const entry of page?.response ?? []) {
      const id = entry?.player?.id;
      if (id == null) continue;
      const statistics = (entry.statistics ?? []).filter((row) => row?.league?.id === leagueId);
      if (!statistics.length) continue;
      const appearances = statistics.reduce(
        (sum, row) => sum + (Number(row.games?.appearences ?? row.games?.appearances) || 0),
        0,
      );
      const minutes = statistics.reduce((sum, row) => sum + (Number(row.games?.minutes) || 0), 0);
      const previous = index.get(id);
      if (previous) {
        previous.appearances += appearances;
        previous.minutes += minutes;
      } else {
        index.set(id, { appearances, minutes });
      }
    }
  }
  return index;
}
