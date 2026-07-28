// How long GET /match/:id's four upstream API-Football payloads may sit in the
// edge cache, chosen from the fixture's own state.
//
// One set of windows (60s / 15m / 60s / 5m) used to apply to every fixture in
// the season. Those are the right windows for a match in progress and badly
// wrong for the other 370, which made /match/:id an unauthenticated amplifier.
// Validating the id only narrows an attacker to the real fixtures, which is
// plenty: cycling those once a minute is roughly 860 upstream calls a minute
// and exhausts a day's API-Football allowance in a couple of hours. That is not
// merely a bill. The scoring, waiver and gameweek cron passes all read the same
// upstream, so draining it stops fantasy for every league, at no cost to the
// attacker and with no account required.
//
// Status is the fix, because at any instant almost nothing is live. A finished
// match's detail is immutable bar rare post-match corrections, and a fixture
// days out has no lineups or events to return at all.
//
// Pure so the choice is unit-testable without a Worker runtime; worker.js wires
// it to the route. Same split as the rest of src/.

export const MATCH_DETAIL_IMMINENT_MS = 2 * 60 * 60 * 1000;

// Named so a profile can be identified by reference at the call site (the route
// picks a browser Cache-Control from whether it got the live one back).
export const MATCH_DETAIL_LIVE = Object.freeze({ fixture: 60, lineups: 15 * 60, events: 60, players: 5 * 60 });
export const MATCH_DETAIL_FINISHED = Object.freeze({
  fixture: 6 * 3600,
  lineups: 6 * 3600,
  events: 6 * 3600,
  players: 6 * 3600,
});
export const MATCH_DETAIL_UPCOMING = Object.freeze({
  fixture: 3600,
  lineups: 3600,
  events: 3600,
  players: 3600,
});

// AWARDED counts as finished for caching just as it does for scoring: the
// result is settled and nothing further will arrive.
function finished(status) {
  return status === "FINISHED" || status === "AWARDED";
}

export function matchDetailCacheProfile(match, now = Date.now()) {
  if (!match) return MATCH_DETAIL_UPCOMING;
  if (finished(match.status)) return MATCH_DETAIL_FINISHED;

  const kickoff = new Date(match.utcDate).getTime();
  // Unknown timing falls to the live profile deliberately. This branch is only
  // reachable on malformed feed data, and a stale drawer during a real match is
  // a worse product than a few extra upstream calls.
  if (!Number.isFinite(kickoff)) return MATCH_DETAIL_LIVE;

  return kickoff - now <= MATCH_DETAIL_IMMINENT_MS ? MATCH_DETAIL_LIVE : MATCH_DETAIL_UPCOMING;
}
