// Stale-on-error policy for the live feed.
//
// The Worker keeps the last good /live body per competition in isolate memory and
// serves it when upstream fails, so a blip does not become an error on somebody's
// screen. That much is deliberate and stays. What was missing is that the entry
// carried no timestamp at all, so nothing downstream could tell a 20-second blip
// from a six-hour outage, and the fallback had no expiry: a sustained upstream
// failure (a spent daily allowance, a per-minute cap being bursted, a plan
// problem) was served as a 200 with a frozen `lastUpdated` for as long as the
// isolate lived, and the minute cron keeps an isolate warm indefinitely.
//
// That is the worst of the three available outcomes for a BROWSER:
//
//   - fresh data                                                        (healthy)
//   - a 502, so src/data.js falls back to the hourly static bake        <- honest
//   - a 200 that never changes again                                   <- was happening
//
// The third is worse than the second because loadLiveData() only reaches for the
// static file when the Worker does NOT answer 200. A stale 200 therefore
// suppresses the fallback that exists for exactly this case, and the static bake
// is refreshed hourly, so past the grace window it is the fresher of the two.
//
// The bound is deliberately applied at the HTTP surface only, not inside getLive.
// Its other callers are the cron passes (kickoff locks, gameweek derivation,
// scoring, waivers) and what they overwhelmingly read is the season SCHEDULE,
// which barely changes: a stale copy still yields correct kickoff times, so it is
// better for them than no feed at all. Bounding inside getLive would make
// currentFantasyMatches fail open sooner during an outage, and failing open means
// no kickoff lock, which is what the retroactive-lineup exploit needs. So the
// cron keeps its resilience and only the browser is handed the 502.
//
// The window is a LIVENESS number, not a correctness one. It only decides how long
// we prefer our own last-known-good over the static bake; both are honest about
// their age via `lastUpdated`. Ten minutes rides out a rate-limit burst or a short
// upstream outage (the blip the fallback was written for) while capping how far a
// live score can lag before the reader is handed something else.
export const LIVE_STALE_GRACE_MS = 10 * 60 * 1000;

// A served stale body is MARKED rather than silently substituted. `lastUpdated`
// already tells the truth about age, but only if a reader thinks to compare it to
// the clock; an explicit flag lets the route, a health check or an operator
// reading the network tab see the degradation for what it is. The age rides along
// because "stale" alone does not distinguish a blip from an outage, and it is what
// the route's own decision is made on.
//
// Returns a COPY: the stored entry is the isolate's only record of the last good
// response, so annotating it in place would let one request's marker leak into the
// next, and a consumer mutating what it was handed would corrupt the fallback.
export function markStaleLive(entry, now = Date.now()) {
  if (!entry?.body) return null;
  // A negative age means the clock moved backwards; the entry provably came from
  // this isolate, so clamp rather than report a negative to any consumer.
  const age = Math.max(0, now - entry.storedAt);
  return { ...entry.body, stale: true, staleAgeMs: age };
}

// The browser-facing half of the decision, kept separate because it applies to the
// route and not to the cron. A body that is not stale at all is always servable;
// a stale one is servable only inside the grace window.
export function tooStaleForBrowser(body) {
  if (!body?.stale) return false;
  return (body.staleAgeMs ?? 0) > LIVE_STALE_GRACE_MS;
}
