// The Average opponent: what an odd-sized league plays instead of a bye.
//
// A round-robin over an odd number of managers leaves exactly one manager
// unpaired every gameweek (see roundRobinSchedule in draftLogic.js, which pads
// with a null and drops that pairing). Until now that manager simply sat out:
// no fixture, no points, no result. That is the correct maths and a bad week -
// you set a lineup, your players scored, and the league told you none of it
// counted. Over a 38-gameweek season in a 9-manager league it happens four
// times each.
//
// So the unpaired manager instead plays "Average", a virtual opponent whose
// score for that gameweek is the MEDIAN of the managers who actually played
// each other that week. Nobody drafts for it, nobody manages it, and it holds
// no players.
//
// Two decisions worth keeping:
//
// MEDIAN, not mean, despite the name. This is the established shape of the
// feature elsewhere (Sleeper and NFL.com both call it the league median) and
// the reason is that a fantasy gameweek has fat tails: one manager catching a
// hat-trick and two clean sheets can drag a mean well above what a typical
// squad scored, so a mean opponent turns "did you have a good week" into "did
// anyone else have a great one". Beating the median means beating half the
// league, which is what players actually understand "average" to promise.
// `AVERAGE_STAT` names which statistic is in use, so the label can stay honest
// if this is ever changed.
//
// The unpaired manager's OWN score is excluded from the median they face. It
// has to be: including it means a big score raises the bar you must clear,
// which is perverse, and you cannot play yourself. What is left is exactly the
// set of managers who played a real fixture that gameweek.
//
// Everything here is DERIVED, never written. There is no Average row in
// `users`, no seat in `fantasy_league_members` and no stored fixture, for the
// same reason `resolveEffectiveLineup` resolves at read time rather than
// copy-writing: a persisted phantom would need a real user id to satisfy
// `fantasy_h2h_fixtures`' foreign keys, and would then have to be excluded by
// hand from the draft, rosters, lineups, waivers, autopilot, push and recaps -
// every one of which correctly ignores it today by simply never seeing it.
//
// Pure: arrays in, arrays out. No DOM, no fetch, no D1.

// Real user ids are AUTOINCREMENT and therefore always >= 1, so 0 is free as a
// sentinel and can never collide with a manager. It is never inserted anywhere.
export const AVERAGE_USER_ID = 0;
export const AVERAGE_NAME = "Average";
export const AVERAGE_STAT = "median";

export function isAverageId(userId) {
  return userId === AVERAGE_USER_ID;
}

// The pseudo-member standings/schedule renderers treat like any other row.
// `isAverage` rides alongside `isBot` rather than reusing it: a bot is a real
// seat with a real squad that a real person could have taken, and calling this
// one a bot would claim a manager exists where none does.
export function averageMember() {
  return { userId: AVERAGE_USER_ID, name: AVERAGE_NAME, isBot: false, isAverage: true };
}

// Middle value, or the mean of the two middle values for an even count.
// Returns null for no scores at all, which is what a gameweek nobody has
// played yet looks like; callers drop the fixture rather than invent a 0-0.
//
// Null and undefined are rejected BEFORE coercion, never after: `Number(null)`
// is 0, so a missing score would otherwise arrive as a real zero and drag the
// median down, which is the same coercion trap the API budget guard rail
// documents. Only genuinely numeric values survive.
export function medianScore(scores) {
  const sorted = (scores ?? [])
    .filter((value) => value != null && value !== "")
    .map(Number)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Which real managers played a real fixture in each gameweek, and which one
// did not. A manager missing from every fixture in a gameweek is the unpaired
// one; with an even league there is never one, and this returns nothing.
function unpairedByGameweek(fixtures, memberIds) {
  const paired = new Map();
  for (const fixture of fixtures ?? []) {
    const gameweek = fixture?.gameweek;
    if (!Number.isInteger(gameweek)) continue;
    if (!paired.has(gameweek)) paired.set(gameweek, new Set());
    paired.get(gameweek).add(fixture.homeUserId);
    paired.get(gameweek).add(fixture.awayUserId);
  }

  const unpaired = new Map();
  for (const [gameweek, played] of paired) {
    const missing = memberIds.filter((id) => !played.has(id));
    // Exactly one missing is the odd-league bye this exists for. Zero is an
    // even league. More than one means the schedule is not a round-robin over
    // these members (a mid-season join, a partial fixture set), and inventing
    // an Average opponent for each of them would be a guess, so it declines.
    if (missing.length === 1) unpaired.set(gameweek, missing[0]);
  }
  return unpaired;
}

// The synthesised fixtures: one per gameweek in which a manager was unpaired
// AND both their own score and at least one real fixture's scores are known.
// The unpaired manager is always the HOME side, so `awayUserId` is reliably
// the Average and a renderer never has to check both ends.
//
// `scores` is [{ gameweek, userId, points }], straight from
// fantasy_gameweek_scores. A gameweek with no score row for the unpaired
// manager yields no fixture at all, which is the honest answer while a
// gameweek is still being scored: the alternative is publishing a result
// against a 0 that has not finished counting.
export function averageFixtures(fixtures, members, scores) {
  const memberIds = (members ?? []).map((member) => member.userId);
  if (memberIds.length % 2 === 0) return []; // even league, no byes to fill
  const unpaired = unpairedByGameweek(fixtures, memberIds);
  if (!unpaired.size) return [];

  const byGameweek = new Map();
  for (const row of scores ?? []) {
    if (!Number.isInteger(row?.gameweek)) continue;
    // Same pre-coercion null check as medianScore: a null `points` must stay
    // absent rather than become a zero somebody has to beat.
    if (row.points == null) continue;
    const points = Number(row.points);
    if (!Number.isFinite(points)) continue;
    if (!byGameweek.has(row.gameweek)) byGameweek.set(row.gameweek, new Map());
    byGameweek.get(row.gameweek).set(row.userId, points);
  }

  const synthesised = [];
  for (const [gameweek, userId] of unpaired) {
    const gameweekScores = byGameweek.get(gameweek);
    const own = gameweekScores?.get(userId);
    if (own == null || !Number.isFinite(own)) continue;
    const others = memberIds
      .filter((id) => id !== userId)
      .map((id) => gameweekScores.get(id))
      .filter((value) => value != null && Number.isFinite(value));
    const median = medianScore(others);
    if (median == null) continue;
    synthesised.push({ gameweek, homeUserId: userId, awayUserId: AVERAGE_USER_ID, homeScore: own, awayScore: median });
  }
  return synthesised;
}

// The whole augmentation in one call, for a caller that just wants a members
// list and a fixture list it can hand straight to standingsFromFixtures.
// Returns the inputs untouched for an even league, so every caller can apply
// this unconditionally rather than testing the league's parity itself.
export function withAverageOpponent(fixtures, members, scores) {
  const synthesised = averageFixtures(fixtures, members, scores);
  if (!synthesised.length) return { fixtures: fixtures ?? [], members: members ?? [] };
  return {
    fixtures: [...(fixtures ?? []), ...synthesised],
    members: [...(members ?? []), averageMember()],
  };
}
