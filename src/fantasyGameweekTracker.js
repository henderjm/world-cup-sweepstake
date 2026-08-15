// Gameweek tracking: where your starting eleven actually is right now, against
// the real Premier League fixtures they are playing in.
//
// The gap this fills: on a Saturday your matchup shows a number that moves and
// nothing that explains it. "Am I ahead?" is answerable; "have I finished, or
// do I still have four players to come?" is the question that decides whether
// being ahead means anything, and it was unanswerable inside the app.
//
// So each starter is placed in one of three states against this gameweek's
// fixtures, and the fixtures themselves are annotated with how many of your
// players are in them. That is the whole feature: a fixture list is public
// information, and what makes it yours is knowing who you have in it.
//
// Pure: matches, roster and starter ids in, a summary out. No DOM, no fetch.
// Live match data comes from the same feed the Scores section already loads,
// so this costs no extra request.

import { gameweekFixtures } from "./fantasyCalendar.js";
import { isFinished, isLive } from "./format.js";

// A player is TO COME, IN PLAY or DONE. Derived from his CLUB's fixtures rather
// than from any per-player feed, because that is the only thing knowable
// without a lineups call per match: this answers "is his match on", not "is he
// on the pitch". Named accordingly, and the view says "matches", never
// "minutes", so it cannot be read as a claim we have not earned.
export const PLAYER_MATCH_STATES = Object.freeze({
  TO_COME: "to_come",
  IN_PLAY: "in_play",
  DONE: "done",
});

// A club in a DOUBLE gameweek is only finished once every one of its fixtures
// is: "done" has to mean nothing left to score, not "the first one ended".
// A blank club (no fixture at all) is done by definition, and is reported
// separately so the view can say so rather than implying he has played.
function stateForFixtures(fixtures) {
  if (!fixtures.length) return { state: PLAYER_MATCH_STATES.DONE, blank: true };
  if (fixtures.some((match) => isLive(match.status))) return { state: PLAYER_MATCH_STATES.IN_PLAY, blank: false };
  if (fixtures.every((match) => isFinished(match.status))) return { state: PLAYER_MATCH_STATES.DONE, blank: false };
  return { state: PLAYER_MATCH_STATES.TO_COME, blank: false };
}

// `{ players, counts, fixtures }` for one manager's starting eleven.
//
// `players` carries each starter with his state and his club's fixtures this
// gameweek. `fixtures` is every fixture in the window that at least one of the
// starters is involved in, newest kickoff last, each stamped with `yours`: how
// many of your starters are in it. A fixture nobody of yours is in is dropped,
// because the Scores section already exists for the full card.
export function trackGameweek({ matches, roster, starterIds, gameweek }) {
  const starters = new Set(starterIds ?? []);
  const squad = (roster ?? []).filter((player) => starters.has(player.id));
  const inWindow = gameweekFixtures(matches ?? [], gameweek);

  const fixturesFor = (team) =>
    inWindow.filter((match) => match.homeTeam === team || match.awayTeam === team);

  const players = squad.map((player) => {
    const fixtures = fixturesFor(player.team);
    const { state, blank } = stateForFixtures(fixtures);
    return { ...player, state, blank, fixtures };
  });

  const counts = {
    total: players.length,
    toCome: players.filter((p) => p.state === PLAYER_MATCH_STATES.TO_COME).length,
    inPlay: players.filter((p) => p.state === PLAYER_MATCH_STATES.IN_PLAY).length,
    done: players.filter((p) => p.state === PLAYER_MATCH_STATES.DONE && !p.blank).length,
    blank: players.filter((p) => p.blank).length,
  };

  // One entry per fixture any starter is in, with your involvement counted.
  const byId = new Map();
  for (const player of players) {
    for (const match of player.fixtures) {
      if (!byId.has(match.id)) byId.set(match.id, { match, yours: [] });
      byId.get(match.id).yours.push(player);
    }
  }
  const fixtures = [...byId.values()].sort((a, b) => {
    // Live first (that is what a manager is here for), then still to come, then
    // finished. Within a group, by kickoff.
    const rank = (entry) => (isLive(entry.match.status) ? 0 : isFinished(entry.match.status) ? 2 : 1);
    return rank(a) - rank(b) || new Date(a.match.utcDate) - new Date(b.match.utcDate);
  });

  return { players, counts, fixtures };
}

// "6 done · 3 in play · 2 to come" — the one line worth reading at a glance.
// Zero-valued parts are omitted rather than printed as "0 in play", which is
// noise on a Tuesday. Returns "" for an empty XI so a caller can drop the line
// entirely rather than render an empty bar.
export function trackerSummary(counts) {
  if (!counts?.total) return "";
  const parts = [];
  if (counts.done) parts.push(`${counts.done} done`);
  if (counts.inPlay) parts.push(`${counts.inPlay} in play`);
  if (counts.toCome) parts.push(`${counts.toCome} to come`);
  if (counts.blank) parts.push(`${counts.blank} blank`);
  return parts.join(" · ");
}

// "COV (H)" — who this player's club plays in this gameweek, and where.
//
// The opponent is the fact that makes a pitch actionable: a manager deciding
// between two midfielders on similar expected points is really deciding
// between two fixtures, and until now they had to leave the app to find out
// what those were.
//
// Three shapes, because a gameweek is a window and all three genuinely happen:
//   one fixture     "COV (H)"
//   a double        "COV (H), EVE (A)"  - he plays twice and scores twice
//   a blank         ""                  - the caller decides how to say so,
//                                         since a pitch tile and a bench row
//                                         have very different room for it.
// `abbr` is injected rather than imported so this module stays free of the
// badge registry, the same way the rest of src/fantasy*.js keeps view lookups
// at the edge.
export function opponentLabel(fixtures, team, abbr = (name) => name) {
  return (fixtures ?? [])
    .map((match) => {
      const home = match.homeTeam === team;
      const opponent = home ? match.awayTeam : match.homeTeam;
      return `${abbr(opponent)} (${home ? "H" : "A"})`;
    })
    .join(", ");
}
