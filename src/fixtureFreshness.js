// Is the feed's own account of a fixture still believable?
//
// The bug this exists for: a Hull City v Man United match well into the second
// half rendered as "not kicked off", with a kickoff time beside it, as though the
// game had not started. That is the app stating something false as fact.
//
// It is worth being precise about WHY, because the symptom invites the wrong
// diagnosis. Nothing in this app decides whether a match has kicked off by
// comparing a clock to a kickoff time — `statusLabel` reads the provider's
// `status` string, and `NS` maps to `TIMED` (src/mapApiFootball.js). So a
// timezone offset cannot produce "not kicked off": only a STALE status can. When
// the Worker cannot reach upstream, the browser falls back to the hourly static
// bake (src/data.js), and a bake written before kickoff says `TIMED` forever.
//
// So the fix is not to recompute the status ourselves — we genuinely do not know
// whether the match is 1-0 or 0-0, and inventing a scoreline would be worse than
// the bare time. The fix is to stop asserting the FALSE half. A fixture whose
// kickoff is comfortably past while the feed still calls it pre-match is a
// fixture we have lost track of, and the honest rendering is "we are behind",
// not a tidy kickoff time that reads as "hasn't started".

// How far past kickoff a pre-match status stops being credible. Kickoffs drift by
// a minute or two (a late coin toss, a delayed broadcast handover) and a fixture
// genuinely starting ten minutes late is news rather than routine, so ten minutes
// separates "the feed is a little behind" from "the feed is wrong" without ever
// flagging a match that really has not started.
export const OVERDUE_GRACE_MS = 10 * 60 * 1000;

// Statuses that assert the match has not begun. Deliberately a small explicit
// set rather than "not live and not finished": POSTPONED and CANCELLED are also
// neither, and a postponed fixture keeps its original kickoff time forever, so
// treating those as overdue would flag every abandoned game in the season.
const PRE_MATCH_STATUSES = new Set(["TIMED", "SCHEDULED"]);

export function isPreMatch(status) {
  return PRE_MATCH_STATUSES.has(status);
}

// True when the feed still calls this fixture pre-match well after it should have
// kicked off. An unparseable or absent kickoff is NOT overdue: with no instant to
// compare against we know nothing, and guessing would put a warning on fixtures
// that never had a time in the first place.
export function isOverdueFixture(match, now = Date.now(), grace = OVERDUE_GRACE_MS) {
  if (!match || !isPreMatch(match.status)) return false;
  const kickoff = new Date(match.utcDate ?? "").getTime();
  if (!Number.isFinite(kickoff)) return false;
  return now - kickoff > grace;
}

export function overdueFixtures(matches, now = Date.now(), grace = OVERDUE_GRACE_MS) {
  return (matches ?? []).filter((match) => isOverdueFixture(match, now, grace));
}

// What the banner should say, or null when there is nothing to warn about.
//
// Two independent signals, and either is enough. `stale` is the Worker telling us
// outright that it served its last-known-good copy (src/liveStale.js). Overdue
// fixtures are the inference we can make without being told, which matters
// because the static-bake path carries no staleness marker at all — it is a file,
// and a file cannot know it is old. The inference is what covers the case the
// user actually hit.
export function feedDelayNotice({ matches, stale = false, staleAgeMs = null, now = Date.now() } = {}) {
  const overdue = overdueFixtures(matches, now);
  if (!overdue.length && !stale) return null;
  return {
    overdue,
    stale: Boolean(stale),
    staleAgeMs: Number.isFinite(staleAgeMs) ? staleAgeMs : null,
    // The worst lag we can actually justify claiming: how long ago the most
    // overdue fixture should have started. Not presented as the data's age,
    // because we do not know that from a static file — only that it is at least
    // this far behind.
    behindByMs: overdue.length
      ? Math.max(...overdue.map((match) => now - new Date(match.utcDate).getTime()))
      : staleAgeMs ?? null,
  };
}
