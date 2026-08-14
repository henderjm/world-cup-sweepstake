// The league's defending champion: who won the season BEFORE this app was
// keeping score (issues #43 and #45).
//
// Pure: member rows in, a decision out. No DOM, no fetch, no D1. Shared by the
// Worker route and the browser so the client cannot offer a choice the server
// would reject, the same split as src/fantasyTeamName.js.
//
// WHY THIS IS SET BY HAND rather than derived. Every settled result lives in
// fantasy_h2h_fixtures forever, so from the moment a league plays its first
// gameweek here the app can work out its own champions with nothing recorded
// during the season. What it cannot do is know anything about the seasons it
// was not there for, and a league arriving from a spreadsheet, a WhatsApp group
// or another product usually brings years of history with it. The commissioner
// is the only available source for that one fact, which is why this is a
// commissioner setting and not a computation waiting on May.
//
// It is deliberately ONE holder rather than a list of past seasons. The app has
// no notion of a season anywhere (a league has a draft_status and nothing else),
// so a seasons table would mean inventing a season vocabulary to hold data
// nobody has asked to enter yet. When the app has completed a season of its own
// to record, that champion is a DERIVED fact and belongs in its own table; this
// is the seed value, the trophy holder as the league arrived.

// A bot manager can never be the holder. A bot seat is created for THIS league
// while it is still pending (see planBotSeats in src/fantasyBots.js), so it did
// not exist during any previous season and cannot have won one. Excluded from
// the picker rather than merely rejected on save, so the illegal choice is
// never offered in the first place.
export function eligibleChampions(members) {
  return (members ?? [])
    .filter((member) => member && !member.isBot)
    .slice()
    .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
}

// Real user ids are AUTOINCREMENT and so always >= 1. Null is "no champion
// recorded", which is every league until a commissioner says otherwise, and 0
// is the Average opponent's sentinel (src/fantasyAverage.js) - neither is a
// person, so both must read as false rather than accidentally matching a row.
export function isChampionId(userId, previousWinnerUserId) {
  if (previousWinnerUserId == null || !(previousWinnerUserId >= 1)) return false;
  return userId === previousWinnerUserId;
}

// The member row holding the trophy, or null when nobody does OR when the
// holder is no longer in the league. Resolved against the member list rather
// than trusted from the stored id, so a champion whose seat has gone quietly
// stops being announced instead of naming somebody who is not there.
export function championMember(members, previousWinnerUserId) {
  if (previousWinnerUserId == null) return null;
  return (members ?? []).find((member) => isChampionId(member?.userId, previousWinnerUserId)) ?? null;
}

// Stamps `isChampion` onto each member row, from the league's single stored id.
//
// The client's view model, never a second source of truth: the Worker sends one
// id on the league (see handleFantasyLeagueDetail) precisely so there is nothing
// per-seat to keep in step, and this expands it once, at the moment a league
// detail lands, so every renderer downstream reads a flag exactly the way it
// already reads isBot. Called on the ONE path that loads a league, so a member
// list can never be half-stamped.
export function withChampionFlags(members, previousWinnerUserId) {
  return (members ?? []).map((member) => ({
    ...member,
    isChampion: isChampionId(member?.userId, previousWinnerUserId),
  }));
}

// Validates a commissioner's choice against the league's own member list.
// Returns { valid: true, userId } or { valid: false, error }, with the error
// already phrased for a person to read: both callers show it verbatim.
//
// Membership is checked here rather than only in SQL because the stored value
// is a bare user id with nothing scoping it to this league, so without this an
// id belonging to a stranger would be stored and then silently never match a
// member - a setting that appears to save and then does nothing.
export function validateChampionChoice(members, userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id < 1) return { valid: false, error: "pick a manager" };

  const member = (members ?? []).find((row) => row?.userId === id);
  if (!member) return { valid: false, error: "that manager is not in this league" };
  if (member.isBot) return { valid: false, error: "a bot manager cannot hold last season's trophy" };

  return { valid: true, userId: id };
}
