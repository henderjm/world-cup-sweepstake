// Pure fantasy gameweek CALENDAR. No DOM, no fetch, no D1: array in, array
// out, so the Worker's scoring cron, its lineup/waiver routes and the browser
// all derive the same windows from the same feed.
//
// THE INVARIANT THIS MODULE EXISTS FOR: a fantasy gameweek is a window of
// wall-clock time, and a fixture belongs to whichever window contains its
// ACTUAL kickoff. It is NOT the provider's `matchday` label.
//
// Why that distinction is load-bearing: API-Football's `matchday` names a
// ROUND of fixtures and never moves when a fixture is rescheduled. A
// gameweek-5 fixture postponed in September and replayed in March still
// carries matchday 5, so "the smallest matchday with an unsettled fixture"
// (the old definition of the current gameweek) collapses back to 5 the moment
// the postponement is published and stays there for the rest of the season.
// Everything keys off that number - lineup writes, waiver runs, the kickoff
// lock, and the standings filter (gameweek < current) - so one routine
// Premier League postponement silently emptied the table from week 5 onward.
//
// Deriving the window boundaries from the data rather than from a fixed weekly
// cadence is also load-bearing: the real schedule has 20-day international
// breaks, midweek rounds two days apart and a winter break, so any assumed
// cadence drifts out of alignment within a couple of months.
//
// The consequence managers actually see is DOUBLE and BLANK gameweeks: a
// replayed fixture lands in a later window alongside that window's own
// fixture, so a club plays twice (double) in one gameweek and, if the
// postponed slot is never refilled, zero times in another (blank). Both are
// normal fantasy football and both are only expressible once a gameweek is a
// window rather than a label.

// Each matchday's ANCHOR is the median kickoff of its fixtures, and the
// boundary between two consecutive gameweeks is the midpoint between their
// anchors. The median rather than the min/max is what makes this robust to
// the very thing the module exists for: the calendar is rebuilt from the live
// feed, which already carries the rescheduled kickoff, so a min/max anchor
// would let one postponed fixture drag its own matchday's window across half
// the season. A minority of moved fixtures cannot move a median.
//
// Verified against the shipped 380-fixture schedule: all 380 fixtures map back
// to their own matchday, so the calendar reproduces the provider's grouping
// exactly on an undisrupted season and only ever differs where a kickoff has
// genuinely moved (see test/fantasy-calendar.test.js).
export function buildGameweekCalendar(matches) {
  const kickoffsByMatchday = new Map();
  for (const match of matches ?? []) {
    if (!Number.isInteger(match?.matchday)) continue;
    const kickoff = toEpochMs(match.utcDate);
    if (!Number.isFinite(kickoff)) continue;
    if (!kickoffsByMatchday.has(match.matchday)) kickoffsByMatchday.set(match.matchday, []);
    kickoffsByMatchday.get(match.matchday).push(kickoff);
  }
  if (!kickoffsByMatchday.size) return [];

  const anchors = [...kickoffsByMatchday.entries()]
    .map(([gameweek, kickoffs]) => ({ gameweek, anchor: median(kickoffs) }))
    .sort((a, b) => a.anchor - b.anchor || a.gameweek - b.gameweek);

  // start/end are half-open [start, end). The first window's start and the
  // last window's end are null, meaning unbounded: every instant in the year
  // belongs to exactly one gameweek, so a fixture moved before the season
  // opener or after the final day still resolves rather than falling through.
  return anchors.map((entry, index) => ({
    gameweek: entry.gameweek,
    anchor: entry.anchor,
    start: index === 0 ? null : (anchors[index - 1].anchor + entry.anchor) / 2,
    end: index === anchors.length - 1 ? null : (entry.anchor + anchors[index + 1].anchor) / 2,
  }));
}

// The gameweek whose window contains `instant`, or null when the calendar is
// empty (no fixture in the list carries both a matchday and a kickoff, which
// is the shape every unit test's toy match list has).
export function gameweekForInstant(calendar, instant) {
  const at = toEpochMs(instant);
  if (!Number.isFinite(at)) return null;
  for (const window of calendar ?? []) {
    if (window.start != null && at < window.start) continue;
    if (window.end != null && at >= window.end) continue;
    return window.gameweek;
  }
  return null;
}

// Stamps each match with the gameweek its actual kickoff falls in. A match
// whose kickoff cannot be placed (no parseable utcDate, or an empty calendar)
// keeps its provider matchday, so a caller handing over a hand-written match
// list without dates still gets the pre-calendar behaviour rather than null.
export function assignGameweeks(matches, calendar) {
  const windows = calendar ?? buildGameweekCalendar(matches);
  return (matches ?? []).map((match) => ({
    ...match,
    gameweek: gameweekForInstant(windows, match?.utcDate) ?? (Number.isInteger(match?.matchday) ? match.matchday : null),
  }));
}

// The gameweek a match belongs to, preferring an already-assigned window over
// the provider's label. Every consumer that used to filter on `match.matchday`
// goes through this, so a caller that has already run assignGameweeks pays for
// it once and an unassigned toy list still works.
export function gameweekOf(match) {
  if (Number.isInteger(match?.gameweek)) return match.gameweek;
  return Number.isInteger(match?.matchday) ? match.matchday : null;
}

// Every match assigned to `gameweek`, which for a replayed fixture is NOT the
// same set as "every match whose matchday equals gameweek".
export function gameweekFixtures(matches, gameweek) {
  return (matches ?? []).filter((match) => gameweekOf(match) === gameweek);
}

// One club's fixtures inside one gameweek window. Zero (a blank gameweek), one
// (normal) or two-plus (a double gameweek, a replayed fixture landing on top
// of the window's own): the whole point of the calendar is that all three are
// expressible, so this returns an array and never a single match.
export function teamGameweekFixtures(matches, gameweek, team) {
  return gameweekFixtures(matches, gameweek).filter(
    (match) => match.homeTeam === team || match.awayTeam === team,
  );
}

// How many times each club plays inside one gameweek, for the UI to label a
// blank (0) or a double (2+) rather than silently showing a manager an XI that
// looks broken. Only clubs with at least one fixture appear; a caller asking
// about a club that is not in the map is asking about a blank gameweek.
export function clubFixtureCounts(matches, gameweek) {
  const counts = new Map();
  for (const match of gameweekFixtures(matches, gameweek)) {
    for (const team of [match.homeTeam, match.awayTeam]) {
      if (!team) continue;
      counts.set(team, (counts.get(team) ?? 0) + 1);
    }
  }
  return counts;
}

// Which of a squad's clubs blank (no fixture in the window, so every player
// from that club scores nothing) or double (two fixtures, so they score twice)
// this gameweek. `players` is [{ team }, ...] and `counts` is whatever
// clubFixtureCounts produced, a Map or the plain object it serialises to over
// the wire. Both lists are club names, deduplicated and sorted, because that
// is what a manager needs told: "Chelsea play twice", not eleven per-player
// badges saying the same thing.
//
// A null/absent `counts` returns empty lists rather than declaring every club
// blank: the feed being unreadable is not the same as a club having no fixture,
// and the second is the only one worth warning a manager about.
export function squadGameweekShape(players, counts) {
  if (counts == null) return { blankTeams: [], doubleTeams: [] };
  const lookup = counts instanceof Map ? counts : new Map(Object.entries(counts));
  const teams = [...new Set((players ?? []).map((player) => player?.team).filter(Boolean))];
  const blankTeams = teams.filter((team) => (lookup.get(team) ?? 0) === 0).sort();
  const doubleTeams = teams.filter((team) => (lookup.get(team) ?? 0) > 1).sort();
  return { blankTeams, doubleTeams };
}

// The last kickoff inside a gameweek window: the instant after which nothing
// further in that gameweek can start, and therefore the natural data-derived
// deadline for anything that must happen "at the end of the gameweek" (see
// waiverRunWindow in fantasyWaivers.js). Null for a gameweek with no fixture
// at all, or one whose fixtures carry no parseable kickoff.
export function lastKickoffInGameweek(matches, gameweek) {
  const kickoffs = gameweekKickoffs(matches, gameweek);
  return kickoffs.length ? Math.max(...kickoffs) : null;
}

// The FIRST kickoff inside a gameweek window: the instant the gameweek starts
// happening, and therefore the anchor for anything that must happen "before
// the gameweek begins" (see squadDeadline in fantasyDeadlines.js). The mirror
// of lastKickoffInGameweek above, and deliberately its neighbour: the two
// anchor the two different deadlines this app has, and a reader comparing them
// should not have to go looking. Null on the same conditions.
export function firstKickoffInGameweek(matches, gameweek) {
  const kickoffs = gameweekKickoffs(matches, gameweek);
  return kickoffs.length ? Math.min(...kickoffs) : null;
}

// The earliest kickoff anywhere in the schedule: the moment the season itself
// starts. Derived from the feed like everything else here, never a hardcoded
// date, so a rescheduled opening fixture moves it. Null for a schedule with no
// parseable kickoff at all.
export function seasonFirstKickoff(matches) {
  const kickoffs = (matches ?? []).map((match) => toEpochMs(match?.utcDate)).filter((value) => Number.isFinite(value));
  return kickoffs.length ? Math.min(...kickoffs) : null;
}

function gameweekKickoffs(matches, gameweek) {
  return gameweekFixtures(matches, gameweek)
    .map((match) => toEpochMs(match.utcDate))
    .filter((value) => Number.isFinite(value));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function toEpochMs(value) {
  if (value == null) return NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return new Date(value).getTime();
}
