import test from "node:test";
import assert from "node:assert/strict";

import {
  DEMO_STAGES,
  FUNNEL_EVENTS,
  PICK_SOURCES,
  claimSubmittedProperties,
  demoAbandonProperties,
  demoDeskProperties,
  demoDraftCompletedProperties,
  demoDraftStartedProperties,
  demoPickProperties,
  demoReportProperties,
  demoSetupProperties,
  demoShareProperties,
  leagueProperties,
  lineupSavedProperties,
  realDraftPickProperties,
} from "../src/funnelEvents.js";

const ALL_BUILDERS = [
  demoSetupProperties,
  demoDraftStartedProperties,
  demoDraftCompletedProperties,
  demoDeskProperties,
  demoReportProperties,
  demoShareProperties,
  demoAbandonProperties,
  leagueProperties,
  realDraftPickProperties,
  lineupSavedProperties,
  claimSubmittedProperties,
];

test("the event vocabulary is unique, frozen and consistently named", () => {
  const names = Object.values(FUNNEL_EVENTS);
  assert.equal(new Set(names).size, names.length, "two keys share an event name");
  assert.ok(Object.isFrozen(FUNNEL_EVENTS));
  for (const name of names) {
    assert.match(name, /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/, `${name} is not snake_case`);
    assert.match(name, /^(demo|fantasy|user)_/, `${name} does not carry a surface prefix`);
  }
});

// The builders run on a live interaction path against mutable app state that
// may be mid-transition. A throw here would take the click with it, so every
// builder has to survive the worst input it could ever be handed.
test("every builder tolerates null, undefined and empty input without throwing", () => {
  for (const build of ALL_BUILDERS) {
    for (const input of [undefined, null, {}, { room: null }, { reportCard: null }]) {
      const result = build(input, undefined, undefined);
      assert.ok(result === null || typeof result === "object", `${build.name} returned a non-object`);
    }
  }
});

test("setup properties send whether a team was named, never the name itself", () => {
  const named = demoSetupProperties({ size: 8, clock: "30", name: "Ana's Invincibles" });
  assert.deepEqual(named, { league_size: 8, clock: "30", named_team: true });
  assert.equal(
    JSON.stringify(named).includes("Ana"),
    false,
    "the typed team name leaked into the event properties",
  );

  assert.equal(demoSetupProperties({ size: 4, clock: "10", name: "" }).named_team, false);
});

test("a draft-started event reports the pool and fixture state that shaped the run", () => {
  const properties = demoDraftStartedProperties({
    size: 6,
    clock: "untimed",
    name: "x",
    pool: { players: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    fixtureData: { matches: [] },
  });
  assert.equal(properties.pool_size, 3);
  assert.equal(properties.pool_unavailable, false);
  assert.equal(properties.has_fixture_data, true);
  assert.equal(properties.league_size, 6);
  assert.equal(properties.clock, "untimed");
});

test("a degraded player pool is reported rather than looking like disinterest", () => {
  const properties = demoDraftStartedProperties({ size: 4, pool: { players: [], unavailable: true }, fixtureData: null });
  assert.equal(properties.pool_unavailable, true);
  assert.equal(properties.pool_size, 0);
  assert.equal(properties.has_fixture_data, false);
});

test("pick properties describe the pick being made and carry its source", () => {
  const demo = {
    size: 8,
    clock: "30",
    room: { round: 3, pickInRound: 5, overallPick: 21 },
    remainingMs: 7400,
    queue: [1, 2],
  };
  const properties = demoPickProperties(demo, { position: "MID", name: "A Player" }, PICK_SOURCES.CLOCK_AUTOPICK);
  assert.equal(properties.round, 3);
  assert.equal(properties.pick_in_round, 5);
  assert.equal(properties.overall_pick, 21);
  assert.equal(properties.position, "MID");
  assert.equal(properties.source, "clock_autopick");
  assert.equal(properties.queue_size, 2);
  // Rounded to whole seconds: a millisecond figure would make every value
  // distinct and useless to group by.
  assert.equal(properties.seconds_left, 7);
});

test("an untimed clock reports no seconds left rather than a misleading zero", () => {
  const properties = demoPickProperties({ clock: "untimed", remainingMs: null, room: {} }, {}, PICK_SOURCES.MANUAL);
  assert.equal(properties.seconds_left, null);
});

test("pick source defaults to manual so an uninstrumented call site cannot invent an autopick", () => {
  assert.equal(demoPickProperties({}, {}, undefined).source, PICK_SOURCES.MANUAL);
});

test("the four pick sources are distinct", () => {
  const values = Object.values(PICK_SOURCES);
  assert.equal(new Set(values).size, values.length);
  assert.deepEqual(values.slice().sort(), ["bot", "clock_autopick", "manual", "queue_autopick"]);
});

test("draft-completed reports the board size", () => {
  const properties = demoDraftCompletedProperties({ size: 4, room: { overallPick: 60 }, queue: [] });
  assert.equal(properties.total_picks, 60);
  assert.equal(properties.league_size, 4);
});

test("desk properties locate the manager in the compressed season", () => {
  const properties = demoDeskProperties(
    { size: 6, desk: { fromGw: 8, toGw: 14 }, season: { chunkIndex: 1, simulatedThrough: 14 } },
    { made_waiver_claim: true },
  );
  assert.equal(properties.chunk_index, 1);
  assert.equal(properties.from_gameweek, 8);
  assert.equal(properties.to_gameweek, 14);
  assert.equal(properties.simulated_through, 14);
  assert.equal(properties.made_waiver_claim, true);
});

test("report properties carry the outcome the manager actually saw", () => {
  const properties = demoReportProperties({
    size: 8,
    reportCard: { position: 2, leagueSize: 8, played: 38, wins: 24, losses: 12, pointsFor: 2100 },
  });
  assert.equal(properties.position, 2);
  assert.equal(properties.league_size, 8);
  assert.equal(properties.wins, 24);
  assert.equal(properties.points_for, 2100);
});

// The shipped instrumentation fired on click and could not tell a completed
// share from a dismissed share sheet, which is the whole question.
test("share properties record the resolved outcome, including a cancelled share", () => {
  const demo = { size: 4, reportCard: { position: 1, leagueSize: 4 } };
  assert.equal(demoShareProperties(demo, "shared").outcome, "shared");
  assert.equal(demoShareProperties(demo, "cancelled").outcome, "cancelled");
  assert.equal(demoShareProperties(demo, "copied").outcome, "copied");
  assert.equal(demoShareProperties(demo, undefined).outcome, "unknown");
  // Observed live in a browser with neither Web Share nor clipboard: a real
  // outcome the click-only metric could never surface.
  assert.equal(demoShareProperties(demo, "unsupported").outcome, "unsupported");
  // The report context rides along, so a share can be sliced by how well the
  // manager actually did.
  assert.equal(demoShareProperties(demo, "shared").position, 1);
});

test("abandonment is not reported for a visitor who never started or who finished", () => {
  assert.equal(demoAbandonProperties({ stage: "setup", size: 8 }), null);
  assert.equal(demoAbandonProperties({ stage: "report", size: 8 }), null);
  assert.equal(demoAbandonProperties({}), null);
  assert.equal(demoAbandonProperties(null), null);
});

test("abandonment says where it broke, not just that it broke", () => {
  const midDraft = demoAbandonProperties({
    stage: "drafting",
    size: 8,
    clock: "10",
    room: { overallPick: 9, round: 2 },
  });
  assert.equal(midDraft.stage, "drafting");
  assert.equal(midDraft.overall_pick, 9);
  assert.equal(midDraft.round, 2);
  // The setup choices travel with it: "abandoned at pick 9" is not actionable,
  // "abandoned at pick 9 of an 8-manager draft on a 10-second clock" is.
  assert.equal(midDraft.league_size, 8);
  assert.equal(midDraft.clock, "10");

  const midSeason = demoAbandonProperties({ stage: "rolling", size: 4, season: { simulatedThrough: 20, chunkIndex: 2 } });
  assert.equal(midSeason.stage, "rolling");
  assert.equal(midSeason.simulated_through, 20);
  assert.equal(midSeason.chunk_index, 2);
});

test("every stage app.js can be in is either an abandonment or explicitly excluded", () => {
  for (const stage of DEMO_STAGES) {
    const properties = demoAbandonProperties({ stage, size: 4 });
    const expected = stage === "setup" || stage === "report" ? null : "object";
    assert.equal(properties === null ? null : typeof properties, expected, `stage ${stage}`);
  }
});

test("a stage this module does not know about is still reported rather than dropped", () => {
  const properties = demoAbandonProperties({ stage: "some_new_stage", size: 4 });
  assert.equal(properties.stage, "some_new_stage");
});

test("league properties never carry the league name or its invite code", () => {
  const properties = leagueProperties(
    { id: 12, name: "Ana's Secret League", inviteCode: "XK4P2Q", members: [1, 2, 3], draftStatus: "pending" },
    { came_from_demo: true },
  );
  assert.equal(properties.league_id, 12);
  assert.equal(properties.league_size, 3);
  assert.equal(properties.draft_status, "pending");
  assert.equal(properties.came_from_demo, true);
  const serialized = JSON.stringify(properties);
  assert.equal(serialized.includes("Ana"), false, "the league name leaked");
  assert.equal(serialized.includes("XK4P2Q"), false, "the invite code leaked");
});

test("league properties read either the camelCase or the snake_case draft status", () => {
  assert.equal(leagueProperties({ id: 1, draft_status: "complete" }).draft_status, "complete");
  assert.equal(leagueProperties({ leagueId: 9 }).league_id, 9);
});

test("real draft picks report the clock the manager was actually under", () => {
  const properties = realDraftPickProperties(
    {
      activeLeagueId: 7,
      league: { members: [1, 2, 3, 4] },
      draftRoom: { state: { round: 2, pickInRound: 1, overallPick: 5 }, remainingMs: 42000 },
      queue: [10],
    },
    { position: "FWD" },
  );
  assert.equal(properties.league_id, 7);
  assert.equal(properties.league_size, 4);
  assert.equal(properties.overall_pick, 5);
  assert.equal(properties.seconds_left, 42);
  assert.equal(properties.position, "FWD");
  assert.equal(properties.queue_size, 1);
});

test("a pick on a player the pool has not got still produces a usable event", () => {
  const properties = realDraftPickProperties({ activeLeagueId: 3, draftRoom: { state: {} } }, undefined);
  assert.equal(properties.league_id, 3);
  assert.equal(properties.position, null);
});

test("a lineup save distinguishes taking control from a routine tweak", () => {
  const takingControl = lineupSavedProperties(
    { activeLeagueId: 4, league: { currentGameweek: 6 }, lineup: { source: "inherited", captainId: 1 } },
    { starters: new Array(11).fill(0), captainId: 2 },
  );
  assert.equal(takingControl.previous_source, "inherited");
  assert.equal(takingControl.captain_changed, true);
  assert.equal(takingControl.starters, 11);
  assert.equal(takingControl.gameweek, 6);

  const routine = lineupSavedProperties(
    { activeLeagueId: 4, league: { currentGameweek: 6 }, lineup: { source: "set", captainId: 2 } },
    { starters: new Array(11).fill(0), captainId: 2 },
  );
  assert.equal(routine.previous_source, "set");
  assert.equal(routine.captain_changed, false);
});

test("the two acquisition paths stay distinguishable", () => {
  const instant = claimSubmittedProperties(
    { activeLeagueId: 2, waivers: { mode: "faab", currentGameweek: 9 } },
    { path: "free_agent", addPlayer: { position: "DEF" } },
  );
  assert.equal(instant.path, "free_agent");
  assert.equal(instant.has_bid, false);

  const queued = claimSubmittedProperties(
    { activeLeagueId: 2, waivers: { mode: "faab", currentGameweek: 9 } },
    { path: "waiver", addPlayer: { position: "DEF" } },
  );
  assert.equal(queued.path, "waiver");
  assert.equal(queued.has_bid, true);
  assert.equal(queued.mode, "faab");
  assert.equal(queued.gameweek, 9);

  // A rolling-priority league has no bid to speak of.
  const rolling = claimSubmittedProperties(
    { activeLeagueId: 2, waivers: { mode: "rolling", currentGameweek: 9 } },
    { path: "waiver", addPlayer: { position: "GK" } },
  );
  assert.equal(rolling.has_bid, false);
});

// A non-finite number reaching PostHog turns into a null or a string
// depending on the serializer, which quietly corrupts an average.
test("non-finite and non-numeric values become null rather than NaN or Infinity", () => {
  const properties = demoPickProperties(
    { size: NaN, room: { round: Infinity, overallPick: "12" }, remainingMs: null, queue: null },
    {},
    PICK_SOURCES.MANUAL,
  );
  assert.equal(properties.league_size, null);
  assert.equal(properties.round, null);
  assert.equal(properties.overall_pick, null);
  assert.equal(properties.queue_size, 0);
});

// -- The static Learn pages' pageview beacon ----------------------------------
// These pages deliberately load no application JavaScript, so the beacon is the
// only thing measuring the site's entire organic-search surface. Its
// constraints are privacy constraints, not style ones, and are asserted here.

import { renderLearnBeacon } from "../src/learnPageView.js";

test("no PostHog config emits no beacon at all", () => {
  assert.equal(renderLearnBeacon(), "");
  assert.equal(renderLearnBeacon({}), "");
  assert.equal(renderLearnBeacon({ key: "phc_x" }), "");
  assert.equal(renderLearnBeacon({ host: "https://eu.i.posthog.com" }), "");
});

test("the beacon posts one anonymous pageview and creates no person profile", () => {
  const html = renderLearnBeacon({ key: "phc_test", host: "https://eu.i.posthog.com" });
  assert.match(html, /^<script>/);
  assert.match(html, /<\/script>$/);
  assert.match(html, /navigator\.sendBeacon/);
  assert.match(html, /"\$pageview"/);
  // Without this, every anonymous learn visit would mint a PostHog person.
  assert.match(html, /\$process_person_profile:false/);
  // No cookie, no localStorage, nothing persisted between pages.
  assert.equal(/document\.cookie|localStorage|sessionStorage/.test(html), false);
});

test("the beacon sends the path only, never the query string", () => {
  const html = renderLearnBeacon({ key: "phc_test", host: "https://eu.i.posthog.com" });
  // location.origin + location.pathname deliberately excludes location.search,
  // so a campaign tag or any other appended parameter cannot ride along.
  assert.match(html, /location\.origin\+location\.pathname/);
  assert.equal(html.includes("location.search"), false);
  assert.equal(html.includes("location.href"), false);
});

test("the beacon cannot throw on a browser without sendBeacon", () => {
  const html = renderLearnBeacon({ key: "phc_test", host: "https://eu.i.posthog.com" });
  assert.match(html, /try\{/);
  assert.match(html, /catch\(e\)\{\}/);
});

test("a trailing slash on the configured host does not produce a double slash", () => {
  const html = renderLearnBeacon({ key: "phc_test", host: "https://eu.i.posthog.com/" });
  assert.match(html, /"https:\/\/eu\.i\.posthog\.com\/e\/"/);
  assert.equal(html.includes("com//e/"), false);
});

test("the api key travels in the POST body, never in a URL", () => {
  const html = renderLearnBeacon({ key: "phc_secret", host: "https://eu.i.posthog.com" });
  const endpoint = html.match(/sendBeacon\((".*?")/)[1];
  assert.equal(endpoint.includes("phc_secret"), false, "the key leaked into the beacon URL");
  assert.match(html, /api_key:"phc_secret"/);
});
