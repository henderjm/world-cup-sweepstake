// The product funnel's event vocabulary and its property builders. Pure data
// and pure functions, no posthog import and no DOM, mirroring the fantasy*.js
// pattern: app.js decides WHEN an event fires, this module decides WHAT it
// says. Split out so the properties can be unit tested, because a funnel event
// with the wrong property is worse than no event - it is a number someone will
// steer the business by.
//
// Two rules hold everywhere in this file and must keep holding:
//
// 1. NO PERSONAL DATA. The only identity PostHog ever receives is the
//    posthog.identify(email) call in account.js. Nothing here may add to that.
//    A manager's typed display name, a league's typed name, an email or an
//    invite code must never become a property; where knowing "did they bother"
//    is useful, send a boolean or a length instead (see `named_team` below).
//    Invite codes especially: they are the join credential.
//
// 2. EVERY BUILDER TOLERATES GARBAGE. These run inside a telemetry call on a
//    user's real interaction. They are handed live mutable app state, often
//    mid-transition, and must return a plain object for a null, an empty or a
//    half-built input rather than throwing. The wrapper in telemetry.js is the
//    backstop, not the excuse.

// The naming convention, which predates this file and is extended rather than
// replaced: snake_case, `<surface>_<object>_<verb in past tense>`. `demo_` is
// the signed-out sandbox, `fantasy_` is a real league, `user_` is the account.
// Deliberately kept: `demo_sim_to_end` does not fit the verb-past-tense rule,
// but it is already shipped and already has history behind it, and renaming an
// event silently splits its own trend in two.
export const FUNNEL_EVENTS = Object.freeze({
  // Landing and entry
  DEMO_ENTERED: "demo_entered",

  // The sandbox draft
  DEMO_DRAFT_STARTED: "demo_draft_started",
  DEMO_PICK_MADE: "demo_pick_made",
  DEMO_DRAFT_COMPLETED: "demo_draft_completed",

  // The compressed season
  DEMO_DESK_REACHED: "demo_desk_reached",
  DEMO_DESK_LINEUP_SAVED: "demo_desk_lineup_saved",
  DEMO_DESK_CLAIM_MADE: "demo_desk_claim_made",
  DEMO_DESK_CONTINUED: "demo_desk_continued",
  DEMO_SIM_TO_END: "demo_sim_to_end",

  // The payoff, and the two exits from it
  DEMO_REPORT_VIEWED: "demo_report_viewed",
  DEMO_RESULT_SHARED: "demo_result_shared",
  DEMO_REAL_LEAGUE_CLICKED: "demo_real_league_clicked",
  DEMO_RESTARTED: "demo_restarted",

  // Leaving the sandbox without finishing it
  DEMO_ABANDONED: "demo_abandoned",

  // A real league
  FANTASY_LEAGUE_CREATED: "fantasy_league_created",
  FANTASY_LEAGUE_JOINED: "fantasy_league_joined",
  FANTASY_LEAGUE_OPENED: "fantasy_league_opened",
  FANTASY_INVITE_COPIED: "fantasy_invite_copied",
  FANTASY_DRAFT_SCHEDULED: "fantasy_draft_scheduled",
  FANTASY_DRAFT_START_REQUESTED: "fantasy_draft_start_requested",
  FANTASY_DRAFT_PICK_MADE: "fantasy_draft_pick_made",
  FANTASY_DRAFT_COMPLETED: "fantasy_draft_completed",
  FANTASY_LINEUP_SAVED: "fantasy_lineup_saved",
  FANTASY_CLAIM_SUBMITTED: "fantasy_claim_submitted",
});

// How a pick reached the board. The three sandbox sources are genuinely
// different product signals and collapsing them would hide the one that
// matters: a draft made mostly of `clock_autopick` is a manager who walked
// away, and it should never read as engagement.
export const PICK_SOURCES = Object.freeze({
  MANUAL: "manual",
  QUEUE_AUTOPICK: "queue_autopick",
  CLOCK_AUTOPICK: "clock_autopick",
  BOT: "bot",
});

// Which stage a manager was on when they left. Mirrors state.demo.stage in
// app.js exactly; a value not in this list means app.js grew a stage and this
// file was not updated, so it is reported verbatim rather than dropped.
export const DEMO_STAGES = Object.freeze(["setup", "drafting", "rolling", "desk", "report"]);

function count(value) {
  return Array.isArray(value) ? value.length : 0;
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Setup choices ride along on nearly every sandbox event on purpose. Knowing
// that someone abandoned at pick 9 is close to useless on its own; knowing
// they abandoned at pick 9 of an 8-manager draft on a 10-second clock is a
// finding, and it is only answerable if the size and clock travel with the
// event rather than sitting on a different one that has to be joined.
export function demoSetupProperties(demo) {
  return {
    league_size: num(demo?.size),
    clock: demo?.clock ?? null,
    // The typed name itself never leaves the browser; whether they bothered to
    // type one is a real intent signal, so send only the boolean.
    named_team: Boolean(demo?.name),
  };
}

export function demoDraftStartedProperties(demo) {
  return {
    ...demoSetupProperties(demo),
    pool_size: count(demo?.pool?.players),
    // A degraded pool or a missing fixture feed changes the whole experience,
    // so a bad demo day is attributable rather than looking like disinterest.
    pool_unavailable: Boolean(demo?.pool?.unavailable),
    has_fixture_data: Boolean(demo?.fixtureData),
  };
}

// `source` is one of PICK_SOURCES. Bot picks are noisy (they are most of the
// board) and are the caller's decision to send or not; this builder does not
// filter them, so the choice stays visible at the call site.
export function demoPickProperties(demo, player, source) {
  const room = demo?.room;
  return {
    ...demoSetupProperties(demo),
    source: source ?? PICK_SOURCES.MANUAL,
    round: num(room?.round),
    pick_in_round: num(room?.pickInRound),
    overall_pick: num(room?.overallPick),
    // Public football data, not personal data.
    position: player?.position ?? null,
    // Seconds left when they committed: the honest read on whether a short
    // clock is exciting or just stressful.
    seconds_left: demo?.remainingMs == null ? null : Math.round(demo.remainingMs / 1000),
    queue_size: count(demo?.queue),
  };
}

export function demoDraftCompletedProperties(demo) {
  return {
    ...demoSetupProperties(demo),
    total_picks: num(demo?.room?.overallPick),
    queue_size: count(demo?.queue),
  };
}

export function demoDeskProperties(demo, extra) {
  const desk = demo?.desk;
  const season = demo?.season;
  return {
    ...demoSetupProperties(demo),
    chunk_index: num(season?.chunkIndex),
    from_gameweek: num(desk?.fromGw),
    to_gameweek: num(desk?.toGw),
    simulated_through: num(season?.simulatedThrough),
    ...(extra ?? {}),
  };
}

export function demoReportProperties(demo) {
  const card = demo?.reportCard;
  return {
    ...demoSetupProperties(demo),
    position: num(card?.position),
    // leagueSize on the card and size on the setup are the same number; the
    // card's is kept because the existing shipped event already sends it and
    // dropping a property breaks whatever is already built on it.
    league_size: num(card?.leagueSize) ?? num(demo?.size),
    played: num(card?.played),
    wins: num(card?.wins),
    losses: num(card?.losses),
    points_for: num(card?.pointsFor),
  };
}

// `outcome` is what the share actually did, straight from sharePaperRun
// (src/paperRunApi.js): "shared" (Web Share went through), "copied" (fell back
// to the clipboard), "cancelled" (the share sheet was dismissed) or
// "unsupported" (neither path available). The shipped instrumentation fired on
// CLICK only, which counts intent and cannot tell a completed share from a
// dismissed sheet, and cannot see "unsupported" at all - which is a bug report,
// not a funnel step, and needs to be separable from the rest.
export function demoShareProperties(demo, outcome) {
  return {
    ...demoReportProperties(demo),
    outcome: outcome ?? "unknown",
  };
}

// Returns null when there is nothing worth reporting, which the caller treats
// as "do not send". A visitor who opened the sandbox, never pressed start and
// wandered off is a bounce already counted by `demo_entered`; emitting an
// abandonment for them would double-count the top of the funnel and make the
// drop-off from setup look artificially severe.
export function demoAbandonProperties(demo) {
  const stage = demo?.stage;
  if (!stage || stage === "setup" || stage === "report") return null;
  return {
    ...demoSetupProperties(demo),
    stage,
    // The whole point of this event: WHERE it broke. A cluster at a low
    // overall_pick is a draft-room problem, a cluster in `rolling` is a
    // patience problem, and the two need opposite fixes.
    overall_pick: num(demo?.room?.overallPick),
    round: num(demo?.room?.round),
    simulated_through: num(demo?.season?.simulatedThrough),
    chunk_index: num(demo?.season?.chunkIndex),
  };
}

// A real league. league_id is a server-assigned integer and is already sent by
// the two shipped feed events; the league's typed NAME and its invite code are
// deliberately absent (rule 1 at the top of this file).
export function leagueProperties(league, extra) {
  return {
    league_id: num(league?.id) ?? num(league?.leagueId),
    league_size: num(league?.members?.length) ?? num(league?.memberCount),
    draft_status: league?.draftStatus ?? league?.draft_status ?? null,
    ...(extra ?? {}),
  };
}

export function realDraftPickProperties(fantasy, player) {
  const room = fantasy?.draftRoom?.state;
  return {
    league_id: num(fantasy?.activeLeagueId),
    league_size: num(fantasy?.league?.members?.length),
    round: num(room?.round),
    pick_in_round: num(room?.pickInRound),
    overall_pick: num(room?.overallPick),
    position: player?.position ?? null,
    seconds_left:
      fantasy?.draftRoom?.remainingMs == null ? null : Math.round(fantasy.draftRoom.remainingMs / 1000),
    queue_size: count(fantasy?.queue),
  };
}

export function lineupSavedProperties(fantasy, edit) {
  return {
    league_id: num(fantasy?.activeLeagueId),
    gameweek: num(fantasy?.league?.currentGameweek),
    // "set" | "inherited" | "default": whether this manager was already
    // actively managing or is overriding an inherited XI for the first time.
    previous_source: fantasy?.lineup?.source ?? null,
    captain_changed: Boolean(edit?.captainId && edit.captainId !== fantasy?.lineup?.captainId),
    starters: count(edit?.starters),
  };
}

export function claimSubmittedProperties(fantasy, flow) {
  const waivers = fantasy?.waivers;
  return {
    league_id: num(fantasy?.activeLeagueId),
    gameweek: num(waivers?.currentGameweek),
    // "free_agent" is the instant path, "waiver" is the queued one. They are
    // different products to the manager and must not be averaged together.
    path: flow?.path ?? null,
    mode: waivers?.mode ?? null,
    position: flow?.addPlayer?.position ?? null,
    has_bid: flow?.path === "waiver" && waivers?.mode === "faab",
  };
}
