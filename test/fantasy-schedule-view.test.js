import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SCHEDULE_VIEW,
  byeNote,
  deadlineBanner,
  isDeadlineSoon,
  matchupTiming,
  scheduleFocusGameweek,
  scheduleRows,
} from "../src/fantasyScheduleView.js";
import { startingUpgrade, worstStarterXp } from "../src/fantasyDraftRank.js";

const HOUR = 60 * 60 * 1000;
const SEASON_START = Date.parse("2026-08-21T19:00:00Z");
const GW1_DEADLINE = Date.parse("2026-08-21T17:00:00Z");
const PRESEASON_NOW = Date.parse("2026-07-28T21:00:00Z");

// -- The pre-season complaint, which is the whole point of this module ----------

test("pre-season names the season start and shows no countdown at all", () => {
  const banner = deadlineBanner({
    gameweek: 1,
    deadline: GW1_DEADLINE,
    locked: false,
    preseason: true,
    seasonStart: SEASON_START,
    now: PRESEASON_NOW,
  });

  assert.equal(banner.kind, "preseason");
  assert.match(banner.headline, /^Season starts /);
  assert.equal(banner.countdown, "", "a countdown three weeks out is exactly what the owner objected to");
  assert.match(banner.detail, /all open/);
  // None of the in-season vocabulary may appear pre-season.
  const text = `${banner.headline} ${banner.detail}`;
  for (const forbidden of ["next gameweek", "quiet", "waiver run", "next run", "deferred"]) {
    assert.ok(!text.toLowerCase().includes(forbidden), `pre-season copy still says "${forbidden}"`);
  }
});

test("on opening day the countdown appears even though the season has not started", () => {
  // Pre-season suppresses the countdown only while the opener is genuinely far
  // off. Three hours out, the deadline is the most useful thing on the screen,
  // and staying silent would be its own kind of dishonest.
  const now = GW1_DEADLINE - 3 * HOUR;
  const banner = deadlineBanner({
    gameweek: 1,
    deadline: GW1_DEADLINE,
    locked: false,
    preseason: true,
    seasonStart: SEASON_START,
    now,
  });
  assert.equal(banner.kind, "open");
  assert.equal(banner.countdown, "3h 0m");
  // Both facts survive: the deadline AND that the season has not begun.
  assert.match(banner.detail, /season starts/i);
  assert.match(banner.detail, /two hours before the first kickoff/);
});

test("a day and a half out from the opener is still the quiet pre-season banner", () => {
  const banner = deadlineBanner({
    gameweek: 1,
    deadline: GW1_DEADLINE,
    locked: false,
    preseason: true,
    seasonStart: SEASON_START,
    now: GW1_DEADLINE - 36 * HOUR,
  });
  assert.equal(banner.kind, "preseason");
  assert.equal(banner.countdown, "");
});

test("in season, the deadline banner counts down and names the lock time", () => {
  const now = GW1_DEADLINE - 3 * HOUR;
  const banner = deadlineBanner({
    gameweek: 7,
    deadline: GW1_DEADLINE,
    locked: false,
    preseason: false,
    seasonStart: SEASON_START,
    now,
  });
  assert.equal(banner.kind, "open");
  assert.equal(banner.headline, "Gameweek 7 deadline");
  assert.equal(banner.countdown, "3h 0m");
  assert.match(banner.detail, /two hours before the first kickoff/);
});

test("a locked squad says so, and still names the season start when pre-season", () => {
  // The two-hour window between gameweek 1's deadline and the opening kickoff:
  // both facts are true and neither may be dropped.
  const banner = deadlineBanner({
    gameweek: 1,
    deadline: GW1_DEADLINE,
    locked: true,
    preseason: true,
    seasonStart: SEASON_START,
    now: GW1_DEADLINE + HOUR,
  });
  assert.equal(banner.kind, "locked");
  assert.match(banner.headline, /locked/);
  assert.match(banner.detail, /season starts/i);
  assert.equal(banner.countdown, "");
});

test("an unreadable feed says the deadline is unknown, never that there is none", () => {
  const banner = deadlineBanner({ gameweek: 3, deadline: null, locked: false, preseason: false, now: Date.now() });
  assert.equal(banner.kind, "unknown");
  assert.match(banner.detail, /could not be read/);
});

test("the deadline reads as urgent only inside the last hour", () => {
  const base = { deadline: GW1_DEADLINE, locked: false, preseason: false, gameweek: 1 };
  const soon = deadlineBanner({ ...base, now: GW1_DEADLINE - 30 * 60 * 1000 });
  assert.equal(isDeadlineSoon(soon, { deadline: GW1_DEADLINE, now: GW1_DEADLINE - 30 * 60 * 1000 }), true);

  const later = deadlineBanner({ ...base, now: GW1_DEADLINE - 5 * HOUR });
  assert.equal(isDeadlineSoon(later, { deadline: GW1_DEADLINE, now: GW1_DEADLINE - 5 * HOUR }), false);

  // A pre-season banner is never urgent, whatever the arithmetic says.
  const pre = deadlineBanner({ ...base, preseason: true, seasonStart: SEASON_START, now: PRESEASON_NOW });
  assert.equal(isDeadlineSoon(pre, { deadline: GW1_DEADLINE, now: PRESEASON_NOW }), false);
});

// -- The matchup card ------------------------------------------------------------

test("a pre-season fixture is upcoming, never a 0-0 scoreline", () => {
  const timing = matchupTiming(
    {
      status: "scheduled",
      gameweek: 1,
      kickoff: SEASON_START,
      deadline: GW1_DEADLINE,
      locked: false,
      preseason: true,
      seasonStart: SEASON_START,
    },
    PRESEASON_NOW,
  );
  assert.equal(timing.showScores, false, "showing scores pre-season is the reported bug");
  assert.equal(timing.label, "Upcoming");
  assert.match(timing.note, /season starts/i);
  assert.match(timing.note, /nothing has been played/i);
});

test("an in-season upcoming fixture names its kickoff and its deadline", () => {
  const timing = matchupTiming(
    {
      status: "scheduled",
      gameweek: 5,
      kickoff: SEASON_START,
      deadline: GW1_DEADLINE,
      locked: false,
      preseason: false,
    },
    SEASON_START - 4 * HOUR,
  );
  assert.equal(timing.showScores, false);
  assert.match(timing.note, /kicks off/);
  assert.match(timing.note, /Squads lock/);
});

test("a live or final matchup shows its scores", () => {
  assert.equal(matchupTiming({ status: "live", gameweek: 5 }, Date.now()).showScores, true);
  const final = matchupTiming({ status: "final", gameweek: 5 }, Date.now());
  assert.equal(final.showScores, true);
  assert.equal(final.label, "Final");
});

test("a bye is explained rather than left blank", () => {
  const note = byeNote(1, 3);
  assert.match(note, /3 managers/);
  assert.match(note, /odd/);
  // The week is not forfeited: an unpaired manager plays Average, so the copy
  // must promise a result rather than a blank week (src/fantasyAverage.js).
  assert.match(note, /play Average/);
  assert.match(note, /median/);
  assert.doesNotMatch(note, /score no points/);
  // Still explains itself when the league size is unknown.
  assert.match(byeNote(1, null), /odd number of managers/);
});

// -- The season schedule ----------------------------------------------------------

// Production League 1's shape: three managers, one fixture a week, one bye.
const SCHEDULE = {
  currentGameweek: 1,
  preseason: true,
  seasonStart: SEASON_START,
  members: [
    { userId: 1, name: "Mark", isBot: false },
    { userId: 2, name: "Rory", isBot: false },
    { userId: 3, name: "Eoin", isBot: false },
  ],
  gameweeks: [
    { gameweek: 1, kickoff: SEASON_START, deadline: GW1_DEADLINE, fixtures: [{ homeUserId: 1, awayUserId: 2, homeScore: null, awayScore: null }], byeUserIds: [3] },
    { gameweek: 2, kickoff: null, deadline: null, fixtures: [{ homeUserId: 2, awayUserId: 3, homeScore: null, awayScore: null }], byeUserIds: [1] },
    { gameweek: 3, kickoff: null, deadline: null, fixtures: [{ homeUserId: 3, awayUserId: 1, homeScore: 61.5, awayScore: 48 }], byeUserIds: [2] },
  ],
};

test("the schedule resolves every manager to a name and attributes every bye", () => {
  const rows = scheduleRows(SCHEDULE, { myUserId: 1, view: "all" });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].fixtures[0].home.name, "Mark");
  assert.equal(rows[0].fixtures[0].away.name, "Rory");
  assert.deepEqual(rows[0].byes.map((bye) => bye.name), ["Eoin"]);
  assert.equal(rows[0].myBye, false);
  assert.equal(rows[1].myBye, true, "Mark byes gameweek 2");
});

test("the default view keeps every gameweek a manager is involved in, byes included", () => {
  assert.equal(DEFAULT_SCHEDULE_VIEW, "mine");
  const rows = scheduleRows(SCHEDULE, { myUserId: 1 });
  // A three-manager league involves each manager every week, whether playing
  // or on a bye, so nothing may be filtered away.
  assert.equal(rows.length, 3);
  assert.equal(rows[1].fixtures.length, 0, "the gameweek Mark byes carries no fixture of his");
  assert.equal(rows[1].myBye, true);
});

test("the mine view drops other managers' fixtures in a bigger league", () => {
  const big = {
    currentGameweek: 1,
    members: [1, 2, 3, 4].map((userId) => ({ userId, name: `M${userId}`, isBot: false })),
    gameweeks: [
      {
        gameweek: 1,
        fixtures: [
          { homeUserId: 1, awayUserId: 2, homeScore: null, awayScore: null },
          { homeUserId: 3, awayUserId: 4, homeScore: null, awayScore: null },
        ],
        byeUserIds: [],
      },
    ],
  };
  assert.equal(scheduleRows(big, { myUserId: 1, view: "all" })[0].fixtures.length, 2);
  assert.equal(scheduleRows(big, { myUserId: 1, view: "mine" })[0].fixtures.length, 1);
});

test("a fixture is only played when BOTH scores are present", () => {
  const rows = scheduleRows(SCHEDULE, { myUserId: 1, view: "all" });
  assert.equal(rows[0].fixtures[0].played, false, "a null score is not a 0-0");
  assert.equal(rows[2].fixtures[0].played, true);

  const half = scheduleRows(
    { members: [], currentGameweek: 1, gameweeks: [{ gameweek: 1, fixtures: [{ homeUserId: 1, awayUserId: 2, homeScore: 40, awayScore: null }], byeUserIds: [] }] },
    { myUserId: 1, view: "all" },
  );
  assert.equal(half[0].fixtures[0].played, false, "half a result is not a result");
});

test("gameweeks are tagged past, current and upcoming from the current gameweek", () => {
  const rows = scheduleRows({ ...SCHEDULE, currentGameweek: 2 }, { myUserId: 1, view: "all" });
  assert.equal(rows[0].isPast, true);
  assert.equal(rows[1].isCurrent, true);
  assert.equal(rows[2].isPast, false);
  assert.equal(rows[2].isCurrent, false);
});

test("the schedule focuses the current gameweek, or the first when it is absent", () => {
  assert.equal(scheduleFocusGameweek(scheduleRows(SCHEDULE, { myUserId: 1, view: "all" })), 1);
  assert.equal(scheduleFocusGameweek(scheduleRows({ ...SCHEDULE, currentGameweek: 99 }, { myUserId: 1, view: "all" })), 1);
  assert.equal(scheduleFocusGameweek([]), null);
});

test("an empty or absent schedule returns no rows rather than throwing", () => {
  assert.deepEqual(scheduleRows(null, { myUserId: 1 }), []);
  assert.deepEqual(scheduleRows({}, { myUserId: 1 }), []);
});

// -- Value against your own team ---------------------------------------------------

test("the upgrade is measured against the worst starter at that position", () => {
  const starters = [
    { position: "MID", xp: 5.4 },
    { position: "MID", xp: 3.1 },
    { position: "FWD", xp: 6.0 },
  ];
  assert.equal(worstStarterXp(starters, "MID"), 3.1);
  assert.equal(Math.round(startingUpgrade({ position: "MID", xp: 4.6 }, starters) * 10) / 10, 1.5);
});

test("a downgrade is reported as negative rather than hidden", () => {
  const starters = [{ position: "FWD", xp: 6.0 }];
  assert.ok(startingUpgrade({ position: "FWD", xp: 4.0 }, starters) < 0);
});

test("a missing xP on either side yields null, never a fabricated zero", () => {
  const starters = [{ position: "MID", xp: 5 }];
  assert.equal(startingUpgrade({ position: "MID", xp: null }, starters), null);
  // No startable xP at that position to compare against.
  assert.equal(startingUpgrade({ position: "GK", xp: 4 }, starters), null);
  // A starter with no xP is skipped rather than treated as zero, which would
  // manufacture a huge upgrade out of a missing number.
  assert.equal(worstStarterXp([{ position: "MID", xp: null }, { position: "MID", xp: 5 }], "MID"), 5);
  assert.equal(startingUpgrade({ position: "MID", xp: 4 }, []), null);
});
