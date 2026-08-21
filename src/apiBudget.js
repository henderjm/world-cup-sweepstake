// What the Worker is still allowed to spend upstream, given how much of the
// API-Football daily allowance is left.
//
// The failure this prevents is not a bill. When the allowance is exhausted
// every upstream call 429s, and getLive is what fantasy scoring, waiver runs,
// gameweek derivation and the kickoff lock all read. So an exhausted key does
// not degrade the match drawer, it stops the whole fantasy product, and it does
// so at the end of the day rather than the start, which is exactly when a
// matchday is settling. Running out is therefore a correctness event, and the
// right response is to spend the last of the allowance on the things a season
// depends on instead of on the things that are merely nice.
//
// The ordering this encodes, cheapest to lose first:
//   1. AI match analysis. Pure garnish; a missing one renders as no card.
//   2. The match drawer's supplementary payloads (lineups, player stats). The
//      drawer already renders a match with neither, and already has a vocabulary
//      for saying so (detail.degraded).
//   3. The drawer's remaining upstream calls. Below this the drawer is built
//      from the fixture summary the route already holds, so it still shows
//      teams, score, kickoff and venue for zero upstream calls.
// Never shed at any level: getLive itself, and every fantasy cron pass. Those
// are the season.
//
// FAILS OPEN, deliberately and in two directions. An unknown allowance (no
// headers seen yet on this isolate, a provider that stopped sending them, a
// malformed value) is NORMAL, never CRITICAL: a guard rail that throttles the
// product because it could not read a gauge is a worse bug than the one it was
// added to prevent. And the thresholds are fractions of the provider's own
// stated limit rather than a hardcoded number, so a plan change moves them
// without a deploy.
//
// The gauge itself is the provider's own remaining count, taken from
// apiQuotaStore's latestQuota rather than from our own counting. That is not a
// preference: the same API key is also spent by the hourly Pages bake and the
// fantasy player-pool script, neither of which passes through this Worker, so
// a self-counted figure reads comfortable right up until the key is exhausted
// by something we never saw.
//
// Pure: no fetch, no clock, no D1.

export const BUDGET_NORMAL = "normal";
export const BUDGET_CONSERVE = "conserve";
export const BUDGET_CRITICAL = "critical";

// Fifteen percent of a day's allowance is roughly two hours of a busy
// matchday's spend at the post-change rates: enough runway to finish the
// evening's fixtures on the essentials alone.
export const CONSERVE_REMAINING_FRACTION = 0.15;
// Five percent is about the cost of settling a full gameweek (scoring every
// finished fixture, then the waiver runs). Below this, nothing discretionary
// may run at all.
export const CRITICAL_REMAINING_FRACTION = 0.05;

// Number(null) is 0 and Number("") is 0, so a missing reading would otherwise
// arrive as "none left" and pin the Worker at CRITICAL. That is precisely the
// distinction parseQuotaHeaders exists to preserve ("we do not know" and "none
// left" must never look the same on a gauge), and it must survive down here too.
function reading(value) {
  if (value == null || value === "") return NaN;
  return Number(value);
}

// `now` is passed in rather than read from a clock, so this stays pure. Omitting
// it disables the refusal check rather than throwing, which is the fail-open
// direction: a caller that cannot supply a clock falls back to judging by the
// gauge alone, exactly as before this existed.
export function budgetLevel(quota, now = null) {
  // An affirmative refusal outranks the gauge, and has to be checked FIRST.
  // A refused response carries no quota headers at all, so the reading below is
  // whatever was last seen while things were healthy: it reads NORMAL through
  // the very incident this guard rail exists for. That was the blind spot.
  //
  // This is not a hole in the fail-open rule, it is the other side of it. That
  // rule is about ABSENT data ("we could not read the gauge" must never look
  // like "none left"). A refusal is present data: upstream saying outright that
  // it will not serve us. Treating that as NORMAL is not failing open, it is
  // ignoring the only unambiguous signal we ever get.
  const limitedUntil = reading(quota?.limitedUntil);
  const at = reading(now);
  if (Number.isFinite(limitedUntil) && Number.isFinite(at) && at < limitedUntil) {
    return BUDGET_CRITICAL;
  }

  const limit = reading(quota?.dailyLimit);
  const remaining = reading(quota?.dailyRemaining);
  // Fail open. Note that limit <= 0 lands here too: a zero limit would make
  // every fraction non-positive and pin the Worker at CRITICAL forever.
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || limit <= 0) return BUDGET_NORMAL;

  const fraction = remaining / limit;
  if (fraction <= CRITICAL_REMAINING_FRACTION) return BUDGET_CRITICAL;
  if (fraction <= CONSERVE_REMAINING_FRACTION) return BUDGET_CONSERVE;
  return BUDGET_NORMAL;
}

// Generating an AI analysis costs an Anthropic call AND, for a live match, the
// three match-detail payloads that build its prompt. First to go.
export function allowsAnalysis(level) {
  return level === BUDGET_NORMAL;
}

// The drawer's lineups and player-stats payloads. Events survive one level
// longer than these two because the timeline is what a reader opens the drawer
// for during a live match, whereas a lineup is unchanged from kickoff and
// player stats are a secondary panel.
export function allowsSupplementaryDetail(level) {
  return level === BUDGET_NORMAL;
}

// Whether GET /match/:id may make any upstream call of its own. False means the
// route answers from the fixture summary it already holds (see
// mapApiFootballMatchDetailFromSummary), which is still a real answer rather
// than an error, at zero upstream cost.
export function allowsInteractiveDetail(level) {
  return level !== BUDGET_CRITICAL;
}

// Red cards for push notifications come from match detail. Kept alive through
// CONSERVE because a missed red card is a wrong notification history rather
// than a missing nicety, and dropped at CRITICAL. Goals, kickoff and full-time
// are unaffected at every level: they come from the batched live-fixture
// request, not from per-match detail.
export function allowsLiveEventDetail(level) {
  return level !== BUDGET_CRITICAL;
}

// Which payloads GET /match/:id should fetch at this level. Returned as data
// rather than as three separate predicates at the call site so the route reads
// as one decision and a test can assert the whole shape at once.
export function matchDetailPlan(level) {
  if (level === BUDGET_CRITICAL) return { fixture: false, lineups: false, events: false, players: false };
  if (level === BUDGET_CONSERVE) return { fixture: true, lineups: false, events: true, players: false };
  return { fixture: true, lineups: true, events: true, players: true };
}
