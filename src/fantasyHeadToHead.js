// Head-to-head records: how each manager has actually fared against each other
// manager (issue #41).
//
// Pure: fixtures and members in, a record grid out. No DOM, no fetch, no D1.
//
// This needs no new recording of any kind. `fantasy_h2h_fixtures` has always
// carried both user ids and both settled scores, so the whole feature is a read
// over data the season already writes - which is why this half of #41 was
// buildable while the trophy-cabinet half waits on a completed season existing
// at all.
//
// The Average opponent (src/fantasyAverage.js) is deliberately INCLUDED. In an
// odd league you genuinely play it several times a season and those results are
// real results that already count in the standings; dropping it here would make
// the head-to-head grid disagree with the table beside it, and a manager's wins
// would not add up. It is labelled, not hidden.

import { AVERAGE_USER_ID } from "./fantasyAverage.js";

// One manager's record against one opponent. `points` are the manager's own
// points scored in those meetings, so a grid can show "3-1, 412 to 380" rather
// than only a win count.
function emptyRecord(opponentId) {
  return { opponentId, played: 0, wins: 0, draws: 0, losses: 0, pointsFor: 0, pointsAgainst: 0 };
}

// `Map<userId, Map<opponentId, record>>` over every SETTLED fixture. A fixture
// with either score missing is skipped entirely: a null is not a zero, and half
// a result is not a result - the same rule scheduleRows and standings already
// apply, restated here rather than assumed because this reads raw rows.
export function headToHeadRecords(fixtures, memberIds) {
  const ids = [...(memberIds ?? [])];
  const grid = new Map(ids.map((id) => [id, new Map()]));

  const record = (userId, opponentId) => {
    if (!grid.has(userId)) return null;
    const row = grid.get(userId);
    if (!row.has(opponentId)) row.set(opponentId, emptyRecord(opponentId));
    return row.get(opponentId);
  };

  for (const fixture of fixtures ?? []) {
    const { homeUserId, awayUserId, homeScore, awayScore } = fixture ?? {};
    if (homeScore == null || awayScore == null) continue;

    const apply = (userId, opponentId, forScore, againstScore) => {
      const entry = record(userId, opponentId);
      if (!entry) return;
      entry.played += 1;
      entry.pointsFor += forScore;
      entry.pointsAgainst += againstScore;
      if (forScore > againstScore) entry.wins += 1;
      else if (forScore < againstScore) entry.losses += 1;
      else entry.draws += 1;
    };

    apply(homeUserId, awayUserId, homeScore, awayScore);
    apply(awayUserId, homeUserId, awayScore, homeScore);
  }

  return grid;
}

// The rows a renderer wants for ONE manager: every opponent they have actually
// met, best record first. Sorted by win rate then by meetings, so "who do I
// own" and "who owns me" read off the top and bottom rather than having to be
// worked out from an unordered list. An opponent never played is omitted
// entirely rather than shown as 0-0, which would imply a fixture that has not
// happened yet is a scoreless draw.
export function headToHeadFor(fixtures, members, userId) {
  const memberIds = (members ?? []).map((member) => member.userId);
  const grid = headToHeadRecords(fixtures, memberIds);
  const mine = grid.get(userId);
  if (!mine) return [];

  const nameOf = new Map((members ?? []).map((member) => [member.userId, member]));

  return [...mine.values()]
    .filter((entry) => entry.played > 0)
    .map((entry) => {
      const opponent = nameOf.get(entry.opponentId) ?? null;
      return {
        ...entry,
        name: opponent?.name ?? "Unknown",
        isBot: Boolean(opponent?.isBot),
        isAverage: Boolean(opponent?.isAverage) || entry.opponentId === AVERAGE_USER_ID,
        winRate: entry.played ? entry.wins / entry.played : 0,
      };
    })
    .sort(
      (a, b) =>
        b.winRate - a.winRate ||
        b.played - a.played ||
        b.pointsFor - a.pointsFor ||
        String(a.name).localeCompare(String(b.name)),
    );
}

// "W3 D0 L1" — compact enough for a table cell, and unambiguous in a way
// "3-0-1" is not (that ordering is a coin flip between countries).
export function formatRecord(entry) {
  if (!entry || !entry.played) return "—";
  return `W${entry.wins} D${entry.draws} L${entry.losses}`;
}
