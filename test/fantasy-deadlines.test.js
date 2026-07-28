import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { assignGameweeks, firstKickoffInGameweek, lastKickoffInGameweek, seasonFirstKickoff } from "../src/fantasyCalendar.js";
import {
  SQUAD_LOCK_LEAD_MS,
  gameweekTimetable,
  lockedSquadPlayerIds,
  playerSquadLock,
  seasonPhase,
  squadDeadline,
  squadLockState,
} from "../src/fantasyDeadlines.js";
import { lockedPlayerIds } from "../src/fantasyLocks.js";
import { WAIVER_QUIET_PERIOD_MS } from "../src/fantasyWaivers.js";

// The real 380-fixture Premier League schedule, for the same reason
// fantasy-calendar.test.js uses it: the ordering invariant between the two
// deadlines has to hold across midweek rounds, international breaks and the
// winter break, and a hand-written fixture list would let a wrong rule pass.
const SCHEDULE = JSON.parse(readFileSync(new URL("../data/PL/live.json", import.meta.url), "utf8"));
const SEASON = assignGameweeks(SCHEDULE.matches);

const HOUR = 60 * 60 * 1000;

// A toy gameweek: two fixtures, a Saturday early game and a Sunday late one,
// so first and last kickoff are genuinely different instants.
function toyWeek({ homeStatus = "SCHEDULED", awayStatus = "SCHEDULED" } = {}) {
  return [
    {
      matchday: 1,
      utcDate: "2026-08-22T11:30:00Z",
      status: homeStatus,
      homeTeam: "Arsenal",
      awayTeam: "Chelsea",
    },
    {
      matchday: 1,
      utcDate: "2026-08-23T15:30:00Z",
      status: awayStatus,
      homeTeam: "Everton",
      awayTeam: "Fulham",
    },
  ];
}

const TOY_FIRST_KO = Date.parse("2026-08-22T11:30:00Z");
const TOY_DEADLINE = TOY_FIRST_KO - SQUAD_LOCK_LEAD_MS;

test("the squad deadline is the gameweek's first kickoff minus two hours", () => {
  assert.equal(SQUAD_LOCK_LEAD_MS, 2 * HOUR);
  assert.equal(squadDeadline(toyWeek(), 1), TOY_DEADLINE);
  assert.equal(new Date(TOY_DEADLINE).toISOString(), "2026-08-22T09:30:00.000Z");
});

test("the deadline is derived from the fixtures, so a rescheduled opener moves it", () => {
  const moved = toyWeek();
  // The Saturday opener is brought forward to the Friday night.
  moved[0] = { ...moved[0], utcDate: "2026-08-21T19:00:00Z" };
  assert.equal(squadDeadline(moved, 1), Date.parse("2026-08-21T19:00:00Z") - SQUAD_LOCK_LEAD_MS);
});

test("squadLockState opens before the deadline and locks from it", () => {
  const before = squadLockState({ matches: toyWeek(), gameweek: 1, now: TOY_DEADLINE - 1 });
  assert.equal(before.locked, false);
  assert.equal(before.msRemaining, 1);

  // Exactly ON the deadline is locked: the deadline is the instant it closes.
  const at = squadLockState({ matches: toyWeek(), gameweek: 1, now: TOY_DEADLINE });
  assert.equal(at.locked, true);
  assert.equal(at.msRemaining, 0);

  const after = squadLockState({ matches: toyWeek(), gameweek: 1, now: TOY_DEADLINE + HOUR });
  assert.equal(after.locked, true);
  // Never counts down past zero into a negative number the UI would print.
  assert.equal(after.msRemaining, 0);
});

test("a gameweek with no derivable kickoff fails open rather than freezing every squad", () => {
  assert.equal(squadDeadline([], 1), null);
  const state = squadLockState({ matches: [], gameweek: 1, now: Date.now() });
  assert.equal(state.deadline, null);
  assert.equal(state.locked, false);
  assert.equal(state.msRemaining, null);
});

// -- The reconciliation ---------------------------------------------------------

test("squad deadline, waiver quiet period and run time are strictly ordered every gameweek", () => {
  // The claim this asserts is the one fantasyDeadlines.js's header makes: the
  // squad closes first and the waiver window closes later, ALWAYS, so a manager
  // can never be told "claims are closed but you may still change your team".
  for (let gameweek = 1; gameweek <= 38; gameweek += 1) {
    const timetable = gameweekTimetable({ matches: SEASON, gameweek, now: 0 });
    const squadDeadlineMs = timetable.squad.deadline;
    const { quietFrom, earliestRunAt } = timetable.waivers;

    assert.ok(squadDeadlineMs != null, `gameweek ${gameweek} has no squad deadline`);
    assert.ok(quietFrom != null, `gameweek ${gameweek} has no quiet period`);

    assert.ok(
      squadDeadlineMs < quietFrom,
      `gameweek ${gameweek}: squad deadline ${new Date(squadDeadlineMs).toISOString()} must precede quiet period ${new Date(quietFrom).toISOString()}`,
    );
    assert.ok(quietFrom < timetable.lastKickoff, `gameweek ${gameweek}: quiet period must precede the last kickoff`);
    assert.ok(timetable.lastKickoff < earliestRunAt, `gameweek ${gameweek}: the run must follow the last kickoff`);

    // And the gap is at least the hour the header claims, not merely positive.
    assert.ok(
      quietFrom - squadDeadlineMs >= HOUR,
      `gameweek ${gameweek}: expected at least an hour between the two deadlines`,
    );
  }
});

test("the ordering holds even for a single-fixture gameweek, the tightest case", () => {
  // One fixture means firstKickoff === lastKickoff, which is where the two
  // deadlines are closest together. The lead (2h) exceeding the quiet period
  // (1h) is what keeps them ordered.
  const single = [{ matchday: 9, utcDate: "2026-10-24T14:00:00Z", status: "SCHEDULED", homeTeam: "A", awayTeam: "B" }];
  const timetable = gameweekTimetable({ matches: single, gameweek: 9, now: 0 });
  assert.equal(firstKickoffInGameweek(single, 9), lastKickoffInGameweek(single, 9));
  assert.ok(timetable.squad.deadline < timetable.waivers.quietFrom);
  assert.equal(timetable.waivers.quietFrom - timetable.squad.deadline, SQUAD_LOCK_LEAD_MS - WAIVER_QUIET_PERIOD_MS);
});

// -- Season phase ---------------------------------------------------------------

test("28 July 2026 is pre-season against the real schedule, which opens on 21 August", () => {
  assert.equal(new Date(seasonFirstKickoff(SEASON)).toISOString(), "2026-08-21T19:00:00.000Z");

  const phase = seasonPhase({ matches: SEASON, now: Date.parse("2026-07-28T21:00:00Z") });
  assert.equal(phase.preseason, true);
  assert.equal(new Date(phase.seasonStart).toISOString(), "2026-08-21T19:00:00.000Z");
  assert.ok(phase.msUntilSeason > 20 * 24 * HOUR);
});

test("the season is under way from its first kickoff onward", () => {
  const phase = seasonPhase({ matches: SEASON, now: Date.parse("2026-08-21T19:00:00Z") });
  assert.equal(phase.preseason, false);
  assert.equal(phase.msUntilSeason, null);
});

test("pre-season and a locked gameweek-1 squad can both be true at once", () => {
  // The two hours between gameweek 1's deadline and the opening kickoff. Both
  // statements are true and the UI must be able to make both; collapsing them
  // into one flag would make one of them lie for two hours.
  const now = Date.parse("2026-08-21T18:00:00Z");
  assert.equal(seasonPhase({ matches: SEASON, now }).preseason, true);
  assert.equal(squadLockState({ matches: SEASON, gameweek: 1, now }).locked, true);
});

test("an unreadable feed is not pre-season, so the UI never invents a season start", () => {
  const phase = seasonPhase({ matches: null, now: Date.now() });
  assert.equal(phase.preseason, false);
  assert.equal(phase.seasonStart, null);
});

// -- The kickoff backstop, and the exploit that must stay closed ----------------

test("the composed rule locks on the deadline before any club has kicked off", () => {
  const matches = toyWeek();
  const justAfter = TOY_DEADLINE + 1;
  const lock = playerSquadLock({ team: "Everton", matches, gameweek: 1, now: justAfter });
  assert.equal(lock.locked, true);
  assert.equal(lock.reason, "deadline");
  // Everton do not kick off until Sunday, so the OLD per-player rule would
  // still have let this through. That gap is the rule change.
  assert.equal(lockedPlayerIds([{ id: 7, team: "Everton" }], matches, 1, justAfter).has(7), false);
});

test("REGRESSION: a club that has kicked off is locked even when no deadline is derivable", () => {
  // The retroactive-lineup cheat (start whoever already scored) must not
  // reopen. This is the case where the deadline arithmetic gives nothing at
  // all - no parseable kickoff in the window - and the backstop is the only
  // thing standing between a manager and a settled result.
  const noDates = [
    { matchday: 1, utcDate: null, status: "IN_PLAY", homeTeam: "Arsenal", awayTeam: "Chelsea" },
  ];
  assert.equal(squadDeadline(noDates, 1), null);
  assert.equal(squadLockState({ matches: noDates, gameweek: 1, now: Date.now() }).locked, false);

  const lock = playerSquadLock({ team: "Arsenal", matches: noDates, gameweek: 1, now: Date.now() });
  assert.equal(lock.locked, true, "a live match must lock regardless of the deadline");
  assert.equal(lock.reason, "live");
});

test("REGRESSION: the composed rule is never weaker than the per-player rule it replaces", () => {
  // Swept across the whole gameweek rather than spot-checked: at every instant
  // the old rule locked a club, the new rule must lock it too. If this ever
  // fails, the rule change has reopened the exploit somewhere.
  const players = [
    { id: 1, team: "Arsenal" },
    { id: 2, team: "Chelsea" },
    { id: 3, team: "Everton" },
    { id: 4, team: "Fulham" },
  ];
  const start = TOY_DEADLINE - 6 * HOUR;
  const end = Date.parse("2026-08-23T20:00:00Z");

  for (let now = start; now <= end; now += 15 * 60 * 1000) {
    // Statuses evolve realistically: a fixture goes live at its kickoff.
    const matches = toyWeek({
      homeStatus: now >= Date.parse("2026-08-22T11:30:00Z") ? "IN_PLAY" : "SCHEDULED",
      awayStatus: now >= Date.parse("2026-08-23T15:30:00Z") ? "IN_PLAY" : "SCHEDULED",
    });
    const oldRule = lockedPlayerIds(players, matches, 1, now);
    const newRule = lockedSquadPlayerIds(players, matches, 1, now);
    for (const id of oldRule) {
      assert.ok(newRule.has(id), `player ${id} was locked by the old rule but not the new one at ${new Date(now).toISOString()}`);
    }
  }
});

test("once the deadline passes the whole squad is locked, not just the clubs that kicked off", () => {
  const players = [
    { id: 1, team: "Arsenal" },
    { id: 2, team: "Everton" },
    { id: 3, team: "Nobody United" }, // no fixture in the window at all
  ];
  const locked = lockedSquadPlayerIds(players, toyWeek(), 1, TOY_DEADLINE + HOUR);
  assert.deepEqual([...locked].sort(), [1, 2, 3]);
});

test("before the deadline nothing is locked, so a manager may still set their team", () => {
  const players = [
    { id: 1, team: "Arsenal" },
    { id: 2, team: "Everton" },
  ];
  const locked = lockedSquadPlayerIds(players, toyWeek(), 1, TOY_DEADLINE - HOUR);
  assert.equal(locked.size, 0);
});

test("a player with no id is skipped rather than throwing", () => {
  const locked = lockedSquadPlayerIds([{ team: "Arsenal" }, null], toyWeek(), 1, TOY_DEADLINE + HOUR);
  assert.equal(locked.size, 0);
});
