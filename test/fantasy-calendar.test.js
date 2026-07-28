import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assignGameweeks,
  buildGameweekCalendar,
  clubFixtureCounts,
  gameweekForInstant,
  lastKickoffInGameweek,
  squadGameweekShape,
  teamGameweekFixtures,
} from "../src/fantasyCalendar.js";
import { currentGameweekFromMatches, gameweekStatus, sumPlayerPoints } from "../src/fantasyGameweek.js";

// The real 380-fixture Premier League schedule, not a toy list: the
// postponement bug below only shows up against a realistic season shape
// (38 rounds, 20-day international breaks, midweek rounds, a winter break),
// and a hand-written six-match fixture list would let a wrong boundary rule
// pass.
const SCHEDULE = JSON.parse(readFileSync(new URL("../data/PL/live.json", import.meta.url), "utf8"));

// Every fixture whose kickoff has already passed is FINISHED, everything else
// is still SCHEDULED: a healthy, undisrupted season frozen at one instant.
function seasonAt(nowIso) {
  return SCHEDULE.matches.map((match) => ({
    ...match,
    status: match.utcDate < nowIso ? "FINISHED" : "SCHEDULED",
  }));
}

// The provider's own behaviour when a fixture is postponed and later given a
// new date: the kickoff moves, the status goes back to a pre-match one, and
// `matchday` does NOT move. That last part is the entire bug.
function reschedule(matches, predicate, newUtcDate) {
  let moved = 0;
  const next = matches.map((match) => {
    if (!predicate(match)) return match;
    moved += 1;
    return { ...match, utcDate: newUtcDate, status: "SCHEDULED" };
  });
  assert.equal(moved, 1, "expected the reschedule helper to move exactly one fixture");
  return next;
}

const isBrentfordChelseaGw5 = (match) =>
  match.matchday === 5 && match.homeTeam === "Brentford" && match.awayTeam === "Chelsea";

// The Monday after gameweek 27 (played 2027-02-27) and before gameweek 28
// (2027-03-03): a completely ordinary end-of-February moment.
const LATE_FEBRUARY = "2027-03-01T12:00:00Z";
// A midweek slot between gameweek 28 (2027-03-03) and gameweek 29 (2027-03-13),
// which is where the Premier League actually replays a postponed match.
const REPLAY_SLOT = "2027-03-10T19:45:00Z";

// -- the calendar reproduces the provider's grouping on a clean season --------

test("buildGameweekCalendar derives 38 non-overlapping windows from the shipped schedule", () => {
  const calendar = buildGameweekCalendar(SCHEDULE.matches);
  assert.equal(calendar.length, 38);
  assert.deepEqual(
    calendar.map((window) => window.gameweek),
    Array.from({ length: 38 }, (_, index) => index + 1),
  );
  assert.equal(calendar[0].start, null, "the first window must be unbounded backwards");
  assert.equal(calendar.at(-1).end, null, "the last window must be unbounded forwards");
  for (let i = 1; i < calendar.length; i += 1) {
    assert.equal(calendar[i].start, calendar[i - 1].end, "windows must abut exactly, with no gap and no overlap");
  }
});

test("every fixture in the undisrupted schedule lands in its own matchday's window", () => {
  // The calendar must be a strict generalisation: on a season where nothing
  // has moved it has to agree with the provider's grouping on all 380
  // fixtures, or it would be silently re-cutting a healthy season.
  const calendar = buildGameweekCalendar(SCHEDULE.matches);
  const mismatched = SCHEDULE.matches.filter(
    (match) => gameweekForInstant(calendar, match.utcDate) !== match.matchday,
  );
  assert.deepEqual(mismatched, []);
});

test("one rescheduled fixture cannot drag its own matchday's window across the season", () => {
  // The calendar is rebuilt from the live feed, which already carries the new
  // kickoff, so the anchor has to be a median rather than a min or a max: a
  // minority of moved fixtures must not move it.
  const clean = buildGameweekCalendar(SCHEDULE.matches);
  const disrupted = buildGameweekCalendar(reschedule(SCHEDULE.matches, isBrentfordChelseaGw5, REPLAY_SLOT));
  assert.deepEqual(
    disrupted.map((window) => [window.gameweek, window.start, window.end]),
    clean.map((window) => [window.gameweek, window.start, window.end]),
  );
});

// -- the bug ------------------------------------------------------------------

test("a gameweek-5 fixture rescheduled into March does not drag the current gameweek back to 5", () => {
  // The reproduction. Under the old "smallest matchday with an unsettled
  // fixture" rule this returned 5 for the rest of the season, which would have
  // pointed lineup writes, waiver runs and the kickoff lock at a gameweek that
  // settled in September and dropped weeks 5 to 27 out of the standings.
  const healthy = seasonAt(LATE_FEBRUARY);
  assert.equal(currentGameweekFromMatches(healthy, LATE_FEBRUARY), 28);

  const disrupted = reschedule(healthy, isBrentfordChelseaGw5, REPLAY_SLOT);
  assert.equal(currentGameweekFromMatches(disrupted, LATE_FEBRUARY), 28);
});

test("the current gameweek never moves backwards as the season is walked forward", () => {
  // The property the calendar exists to guarantee. Walked week by week across
  // the whole season, with the gameweek-5 postponement applied throughout, the
  // answer must be monotonically non-decreasing.
  let previous = 0;
  for (let day = 0; day < 300; day += 3) {
    const now = new Date(Date.parse("2026-08-18T12:00:00Z") + day * 86400000).toISOString();
    const matches = reschedule(seasonAt(now), isBrentfordChelseaGw5, REPLAY_SLOT).map((match) => ({
      ...match,
      status: match.utcDate < now ? "FINISHED" : "SCHEDULED",
    }));
    const current = currentGameweekFromMatches(matches, now);
    assert.ok(current >= previous, `gameweek went backwards at ${now}: ${previous} then ${current}`);
    previous = current;
  }
});

test("the replayed fixture is scored in the window it was actually played in", () => {
  const disrupted = assignGameweeks(reschedule(seasonAt(LATE_FEBRUARY), isBrentfordChelseaGw5, REPLAY_SLOT));
  const replayed = disrupted.find((match) => match.utcDate === REPLAY_SLOT);
  assert.equal(replayed.matchday, 5, "the provider label is deliberately left alone");
  assert.equal(replayed.gameweek, 29, "the calendar places it by its real kickoff");
});

// -- double and blank gameweeks ----------------------------------------------

test("a replayed fixture produces a double gameweek for both clubs", () => {
  const disrupted = assignGameweeks(reschedule(seasonAt(LATE_FEBRUARY), isBrentfordChelseaGw5, REPLAY_SLOT));
  assert.equal(teamGameweekFixtures(disrupted, 29, "Brentford").length, 2);
  assert.equal(teamGameweekFixtures(disrupted, 29, "Chelsea").length, 2);

  const counts = clubFixtureCounts(disrupted, 29);
  assert.equal(counts.get("Brentford"), 2);
  assert.equal(counts.get("Chelsea"), 2);
  // Everyone else still plays exactly once, so the window has not been re-cut.
  const others = [...counts.entries()].filter(([team]) => team !== "Brentford" && team !== "Chelsea");
  assert.ok(others.every(([, count]) => count === 1));
});

test("the vacated week becomes a blank gameweek for both clubs", () => {
  const disrupted = assignGameweeks(reschedule(seasonAt(LATE_FEBRUARY), isBrentfordChelseaGw5, REPLAY_SLOT));
  assert.deepEqual(teamGameweekFixtures(disrupted, 5, "Brentford"), []);
  const counts = clubFixtureCounts(disrupted, 5);
  assert.equal(counts.has("Brentford"), false);
  assert.equal(counts.has("Chelsea"), false);
  assert.equal(counts.size, 18, "the other nine fixtures of gameweek 5 are untouched");
});

test("gameweekStatus holds a window open until its replayed fixture is settled too", () => {
  const disrupted = assignGameweeks(reschedule(seasonAt(LATE_FEBRUARY), isBrentfordChelseaGw5, REPLAY_SLOT));
  // Gameweek 5's own ten fixtures minus the one that left: all long finished.
  assert.equal(gameweekStatus(disrupted, 5), "final");

  // Gameweek 29 now owns eleven fixtures. Finish the ten scheduled ones and it
  // must still not be final while the replayed match is outstanding.
  const tenDone = disrupted.map((match) =>
    match.gameweek === 29 && match.utcDate !== REPLAY_SLOT ? { ...match, status: "FINISHED" } : match,
  );
  assert.equal(gameweekStatus(tenDone, 29), "live");

  const allDone = tenDone.map((match) => (match.gameweek === 29 ? { ...match, status: "FINISHED" } : match));
  assert.equal(gameweekStatus(allDone, 29), "final");
});

// -- calendar primitives ------------------------------------------------------

test("gameweekForInstant places an instant before the season opener in gameweek 1", () => {
  const calendar = buildGameweekCalendar(SCHEDULE.matches);
  assert.equal(gameweekForInstant(calendar, "2026-07-01T00:00:00Z"), 1);
  assert.equal(gameweekForInstant(calendar, "2027-08-01T00:00:00Z"), 38);
});

test("gameweekForInstant returns null when there is no calendar to place it in", () => {
  assert.equal(gameweekForInstant([], "2027-01-01T00:00:00Z"), null);
  assert.equal(gameweekForInstant(buildGameweekCalendar([{ matchday: 1, status: "TIMED" }]), 0), null);
});

test("assignGameweeks falls back to the provider matchday when a fixture carries no date", () => {
  // Every unit test's toy match list has this shape, and so does a feed that
  // has not published a kickoff yet; neither should lose its gameweek.
  const assigned = assignGameweeks([
    { matchday: 7, status: "TIMED" },
    { matchday: 8, status: "TIMED" },
  ]);
  assert.deepEqual(assigned.map((match) => match.gameweek), [7, 8]);
});

test("lastKickoffInGameweek follows the window's real fixtures, not the matchday label", () => {
  const disrupted = assignGameweeks(reschedule(seasonAt(LATE_FEBRUARY), isBrentfordChelseaGw5, REPLAY_SLOT));
  // The gameweek-5 fixture that moved out no longer sets gameweek 5's deadline,
  // which is what stops a waiver run for an already-settled week from having
  // its timetable dragged into March along with the fixture.
  assert.equal(lastKickoffInGameweek(disrupted, 5), Date.parse("2026-09-20T15:30:00Z"));
  // It is counted in gameweek 29, where it was actually played, even though the
  // window's own round kicks off later still.
  assert.ok(teamGameweekFixtures(disrupted, 29, "Chelsea").some((match) => match.utcDate === REPLAY_SLOT));
  assert.equal(lastKickoffInGameweek(disrupted, 29), Date.parse("2027-03-13T12:00:00Z"));
  assert.equal(lastKickoffInGameweek(disrupted, 99), null);
});

// -- double-gameweek scoring --------------------------------------------------

test("sumPlayerPoints accumulates a player's two matches inside one gameweek", () => {
  const totals = sumPlayerPoints([
    { playerId: 1, points: 6 },
    { playerId: 2, points: 2 },
    { playerId: 1, points: 9 }, // the same player's second match of a double gameweek
  ]);
  assert.equal(totals.get(1), 15);
  assert.equal(totals.get(2), 2);
});

test("sumPlayerPoints ignores rows with no player id rather than keying on undefined", () => {
  const totals = sumPlayerPoints([{ points: 5 }, { playerId: null, points: 5 }, { playerId: 3, points: 1 }]);
  assert.deepEqual([...totals.entries()], [[3, 1]]);
});

// -- what the UI is told ------------------------------------------------------

test("squadGameweekShape names only the squad's own blank and double clubs", () => {
  const roster = [
    { id: 1, team: "Brentford" },
    { id: 2, team: "Chelsea" },
    { id: 3, team: "Arsenal" },
    { id: 4, team: "Arsenal" },
  ];
  const counts = { Brentford: 2, Arsenal: 1, Everton: 2 };
  const shape = squadGameweekShape(roster, counts);
  assert.deepEqual(shape.doubleTeams, ["Brentford"]); // Everton is not in this squad
  assert.deepEqual(shape.blankTeams, ["Chelsea"]); // absent from the counts entirely
});

test("squadGameweekShape reports nothing at all when the fixture counts are unknown", () => {
  // An unreadable feed is not the same as every club having a blank gameweek,
  // and only the second is worth warning a manager about.
  assert.deepEqual(squadGameweekShape([{ team: "Chelsea" }], null), { blankTeams: [], doubleTeams: [] });
});

test("squadGameweekShape accepts the Map clubFixtureCounts produces as well as its wire form", () => {
  const counts = clubFixtureCounts(
    [
      { gameweek: 4, homeTeam: "Chelsea", awayTeam: "Arsenal" },
      { gameweek: 4, homeTeam: "Chelsea", awayTeam: "Everton" },
    ],
    4,
  );
  assert.deepEqual(squadGameweekShape([{ team: "Chelsea" }, { team: "Leeds United" }], counts), {
    blankTeams: ["Leeds United"],
    doubleTeams: ["Chelsea"],
  });
});
