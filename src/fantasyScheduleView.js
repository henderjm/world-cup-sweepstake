// Pure view-layer logic for the season schedule, the squad-deadline banner and
// the matchup card's "what is actually happening right now" line. No DOM, no
// fetch: fantasyView.js renders with these and app.js wires the clicks, the
// same split as fantasyWaiversView.js.
//
// Everything here answers one product complaint: pre-season, the app described
// a deadline and a waiver run three weeks away as though they were imminent,
// and showed a fixture nobody had played as a 0-0 scoreline. The fix is not
// new numbers, it is refusing to render in-season vocabulary when the season
// has not started. So "pre-season" is its own first-class state throughout
// this file rather than a degenerate case of the in-season one.

import { formatLocalSchedule, formatScheduleCountdown } from "./fantasyScheduling.js";

// -- The squad deadline banner --------------------------------------------------

// What a manager needs told about their squad's deadline, as data the renderer
// just prints. `kind` drives the styling and is one of:
//
//   "preseason"  the season has not started. No countdown, no gameweek
//                deadline language: name the date the season starts and say
//                everything is open, which is the whole of item 2 in the brief.
//   "open"       the season is under way and the deadline is still ahead.
//   "locked"     the deadline has passed; this gameweek's squad is frozen.
//   "unknown"    no deadline could be derived (feed unreadable). Says so,
//                rather than implying there is no deadline at all.
//
// "locked" deliberately outranks "preseason": for the two hours between
// gameweek 1's deadline and the opening kickoff both are true, and the one
// that changes what a manager may DO is the lock (see seasonPhase's own note
// in fantasyDeadlines.js). The season-start fact is still carried in `detail`
// there, so neither statement is lost.
export function deadlineBanner({ gameweek, deadline, locked, preseason, seasonStart, now } = {}) {
  const at = Number(now);

  if (locked) {
    return {
      kind: "locked",
      headline: `Gameweek ${gameweek} squad locked`,
      detail: preseason
        ? `The season starts ${formatLocalSchedule(seasonStart)}. Your squad is already locked for the opening gameweek.`
        : `Locked ${formatLocalSchedule(deadline)}, two hours before the first kickoff.`,
      countdown: "",
    };
  }

  // Pre-season suppresses the countdown, but only while the opening deadline is
  // genuinely far off. On the morning of the opener the deadline is hours away
  // and a countdown is the single most useful thing on the screen, so once it
  // is inside PRESEASON_COUNTDOWN_MS this falls through to the ordinary "open"
  // state below. Suppressing it right up to kickoff would trade one dishonest
  // screen (a countdown three weeks out) for another (no warning at all).
  const untilDeadline = deadline != null && Number.isFinite(at) ? deadline - at : null;
  const deadlineImminent = untilDeadline != null && untilDeadline <= PRESEASON_COUNTDOWN_MS;

  if (preseason && seasonStart != null && !deadlineImminent) {
    return {
      kind: "preseason",
      headline: `Season starts ${formatLocalSchedule(seasonStart)}`,
      detail:
        "Pre-season: lineups, captaincy and transfers are all open, and no player is locked. Squads lock two hours before the first kickoff of each gameweek.",
      countdown: "",
    };
  }

  if (deadline == null) {
    return {
      kind: "unknown",
      headline: "Deadline not available",
      detail: "The fixture list could not be read just now, so this gameweek's deadline is unknown.",
      countdown: "",
    };
  }

  return {
    kind: "open",
    headline: `Gameweek ${gameweek} deadline`,
    // Still names the season start when the season has not begun, so the
    // opening-day banner carries both facts rather than dropping one.
    detail:
      preseason && seasonStart != null
        ? `The season starts ${formatLocalSchedule(seasonStart)}. Squads lock ${formatLocalSchedule(deadline)}, two hours before the first kickoff.`
        : `Squads lock ${formatLocalSchedule(deadline)}, two hours before the first kickoff.`,
    countdown: untilDeadline == null ? "" : formatScheduleCountdown(untilDeadline),
  };
}

// How close the opening deadline has to be before the pre-season framing stops
// suppressing the countdown. A day is deliberately generous: it covers "I am
// checking my team the night before the season starts", which is exactly when
// a manager wants the number.
const PRESEASON_COUNTDOWN_MS = 24 * 60 * 60 * 1000;

// Whether the banner should read as urgent (inside the last hour), the same
// threshold and the same visual emphasis the draft-schedule countdown already
// uses, rather than inventing a second notion of "soon".
const ONE_HOUR_MS = 60 * 60 * 1000;
export function isDeadlineSoon(banner, { deadline, now } = {}) {
  if (banner?.kind !== "open" || deadline == null || !Number.isFinite(Number(now))) return false;
  const remaining = deadline - Number(now);
  return remaining >= 0 && remaining <= ONE_HOUR_MS;
}

// -- The matchup card ------------------------------------------------------------

// What the matchup card says INSTEAD of a scoreline, and whether a scoreline
// should be shown at all. A fixture nobody has played is upcoming, not 0-0:
// that was the owner's first complaint and it is decided here rather than in
// the renderer, so the same rule is testable.
//
// `showScores` is false for anything not yet started, which is what stops a
// pre-season fixture rendering as a result.
export function matchupTiming(matchup, now) {
  const { status, gameweek, kickoff, deadline, locked, preseason, seasonStart } = matchup ?? {};
  const started = status === "live" || status === "final";

  if (started) {
    return {
      showScores: true,
      label: status === "live" ? "Live" : "Final",
      note: status === "live" ? "Scores update as matches finish." : `Gameweek ${gameweek} is complete.`,
    };
  }

  // Not started. Everything below is deliberately free of "next gameweek",
  // "quiet period" and "next waiver run" language.
  if (preseason && seasonStart != null) {
    return {
      showScores: false,
      label: "Upcoming",
      note: `The season starts ${formatLocalSchedule(seasonStart)}. This is your opening fixture; nothing has been played yet.`,
    };
  }

  if (kickoff != null) {
    const remaining = Number.isFinite(Number(now)) ? kickoff - Number(now) : null;
    const countdown = remaining != null && remaining > 0 ? ` (${formatScheduleCountdown(remaining)})` : "";
    return {
      showScores: false,
      label: "Upcoming",
      note: locked
        ? `Gameweek ${gameweek} kicks off ${formatLocalSchedule(kickoff)}${countdown}. Your squad is locked.`
        : `Gameweek ${gameweek} kicks off ${formatLocalSchedule(kickoff)}${countdown}. Squads lock ${
            deadline == null ? "two hours before" : formatLocalSchedule(deadline)
          }.`,
    };
  }

  return { showScores: false, label: "Upcoming", note: "This fixture has not been played yet." };
}

// A bye, said plainly. An odd-sized league leaves somebody unpaired every
// single week, and the manager it happens to used to see nothing at all, which
// is indistinguishable from a bug. `leagueSize` is only used to explain WHY,
// and is omitted from the explanation when we do not know it.
//
// The week is no longer forfeited: the unpaired manager plays Average, whose
// score is the median of the managers who did play each other (see
// src/fantasyAverage.js). This copy has to keep step with that, or the schedule
// would still be promising a blank week while the standings recorded a result.
export function byeNote(gameweek, leagueSize) {
  const why =
    Number.isFinite(leagueSize) && leagueSize % 2 === 1
      ? `Your league has ${leagueSize} managers, an odd number, so one manager is unpaired every gameweek and this week it is you.`
      : "There is an odd number of managers to pair up this gameweek, so one of you is unpaired and this week it is you.";
  return `${why} You play Average for gameweek ${gameweek}: your points still count, and you win by outscoring the median of the managers who played each other.`;
}

// -- The season schedule ----------------------------------------------------------

export const SCHEDULE_VIEWS = [
  ["mine", "My fixtures"],
  ["all", "All fixtures"],
];

export const DEFAULT_SCHEDULE_VIEW = "mine";

// Turns the raw GET /fantasy/league/:id/schedule payload into rows a renderer
// can print without any further lookups: every name resolved, every bye
// attributed to a person, and each gameweek tagged past/current/upcoming.
//
// `view` is "mine" (only gameweeks the caller plays or byes in, which for an
// odd-sized league is every gameweek, and for a large league is the useful
// subset) or "all". Filtering here rather than in the renderer keeps the empty
// state honest: a filter that matches nothing returns an empty array and the
// renderer says so, instead of silently printing a blank table.
//
// A fixture is only ever `played` when BOTH scores are present. A single null
// score is not a 0, and half a result is not a result.
export function scheduleRows(schedule, { myUserId, view = DEFAULT_SCHEDULE_VIEW } = {}) {
  const names = new Map((schedule?.members ?? []).map((member) => [member.userId, member]));
  const current = schedule?.currentGameweek;

  const rows = (schedule?.gameweeks ?? []).map((week) => {
    const byeUserIds = week.byeUserIds ?? [];
    const fixtures = (week.fixtures ?? []).map((fixture) => {
      const played = fixture.homeScore != null && fixture.awayScore != null;
      return {
        home: names.get(fixture.homeUserId) ?? { userId: fixture.homeUserId, name: "Unknown", isBot: false },
        away: names.get(fixture.awayUserId) ?? { userId: fixture.awayUserId, name: "Unknown", isBot: false },
        homeScore: fixture.homeScore,
        awayScore: fixture.awayScore,
        played,
        involvesMe: fixture.homeUserId === myUserId || fixture.awayUserId === myUserId,
      };
    });

    return {
      gameweek: week.gameweek,
      kickoff: week.kickoff ?? null,
      deadline: week.deadline ?? null,
      isCurrent: week.gameweek === current,
      isPast: Number.isFinite(current) && week.gameweek < current,
      fixtures,
      byes: byeUserIds.map((id) => names.get(id) ?? { userId: id, name: "Unknown", isBot: false }),
      myBye: byeUserIds.includes(myUserId),
    };
  });

  if (view !== "mine") return rows;
  return rows
    .filter((row) => row.myBye || row.fixtures.some((fixture) => fixture.involvesMe))
    .map((row) => ({ ...row, fixtures: row.fixtures.filter((fixture) => fixture.involvesMe) }));
}

// The gameweek the schedule should scroll to on open: the current one if it is
// in the list, otherwise the first. Null for an empty schedule, so the caller
// renders its empty state rather than scrolling to nothing.
export function scheduleFocusGameweek(rows) {
  if (!rows?.length) return null;
  return (rows.find((row) => row.isCurrent) ?? rows[0]).gameweek;
}
