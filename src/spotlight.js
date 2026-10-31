// The "For you" spotlight at the top of Scores: the app chooses what is worth
// looking at so a visitor never has to filter, pick a league or scroll to find
// it. Pure, so the ranking is testable and the renderer stays dumb.
//
// Order of preference:
//   1. A followed team's match: live first, then the next kickoff today, then
//      the most recent result today. A fan's own club beats any neutral drama.
//   2. With nothing followed in play today, the live match most worth
//      switching to: latest minute first, closest scoreline breaking ties,
//      labelled "Match of the moment".
//   3. With nothing live, the next kickoff on the day, so a matchday morning
//      still leads with something to look forward to.
// Nothing live, followed or still to come means no spotlight at all.

import { isFinished, isLive } from "./format.js";
import { followsTeam } from "./teamFollows.js";

export const SPOTLIGHT_MAX = 2;

const KICKOFF_PENDING = new Set(["TIMED", "SCHEDULED"]);

function hasScore(score) {
  return Number.isFinite(score?.home) && Number.isFinite(score?.away);
}

function goalGap(match) {
  return hasScore(match.score) ? Math.abs(match.score.home - match.score.away) : 0;
}

function followed(match, follows) {
  const code = match.competitionCode ?? null;
  return followsTeam(follows, code, match.homeTeam) || followsTeam(follows, code, match.awayTeam);
}

function followedRank(match) {
  if (isLive(match.status)) return 0;
  if (KICKOFF_PENDING.has(match.status)) return 1;
  if (isFinished(match.status)) return 2;
  return 3;
}

export function tensionOrder(a, b) {
  return (b.minute ?? 0) - (a.minute ?? 0) || goalGap(a) - goalGap(b);
}

// `matches` are the selected day's matches, each carrying its competitionCode.
export function spotlightMatches(matches, follows = [], max = SPOTLIGHT_MAX) {
  const mine = matches
    .filter(match => followed(match, follows) && followedRank(match) < 3)
    .sort((a, b) => followedRank(a) - followedRank(b)
      || (followedRank(a) === 2
        ? new Date(b.utcDate) - new Date(a.utcDate)
        : new Date(a.utcDate) - new Date(b.utcDate)));
  if (mine.length) return mine.slice(0, max).map(match => ({ match, reason: "followed" }));
  const live = matches.filter(match => isLive(match.status)).sort(tensionOrder);
  if (live.length) return [{ match: live[0], reason: "tension" }];
  const next = matches
    .filter(match => KICKOFF_PENDING.has(match.status))
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate))[0];
  return next ? [{ match: next, reason: "next" }] : [];
}
