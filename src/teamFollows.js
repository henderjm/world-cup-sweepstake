import { COMPETITIONS } from "./competitions.js";

export const LOCAL_FOLLOWS_KEY = "gs-local-follows";
const key = follow => JSON.stringify([follow.competition, follow.team]);

export function uniqueFollows(follows) {
  return [...new Map((Array.isArray(follows) ? follows : []).filter(follow =>
    follow && Object.hasOwn(COMPETITIONS, follow.competition) && typeof follow.team === "string"
    && follow.team.length > 0 && follow.team.length <= 60 && follow.team.trim() === follow.team,
  ).map(follow => [key(follow), { competition: follow.competition, team: follow.team }])).values()];
}

export function followsTeam(follows, competition, team) {
  return follows.some(follow => follow.competition === competition && follow.team === team);
}

export function followedMatches(feed, follows) {
  return (feed.matches ?? []).filter(match => followsTeam(follows, feed.competition.code, match.homeTeam)
    || followsTeam(follows, feed.competition.code, match.awayTeam));
}

export function createLocalFollows(storage = () => globalThis.localStorage) {
  let entries = [];
  let persistent = true;
  const reload = () => {
    try {
      entries = uniqueFollows(JSON.parse(storage().getItem(LOCAL_FOLLOWS_KEY) || "[]")).slice(0, 50);
      persistent = true;
    } catch {
      persistent = false;
    }
  };
  reload();
  return {
    all: () => entries.map(entry => ({ ...entry })),
    get persistent() { return persistent; },
    reload,
    set(competition, team, following) {
      const item = uniqueFollows([{ competition, team }])[0];
      if (!item) throw Error("This team cannot be followed.");
      const next = entries.filter(entry => key(entry) !== key(item));
      if (following) next.push(item);
      if (next.length > 50) throw Error("You can follow up to 50 teams on this device.");
      entries = next;
      try {
        storage().setItem(LOCAL_FOLLOWS_KEY, JSON.stringify(entries));
        persistent = true;
      } catch {
        // Keep the choice for this visit and disclose that it will not persist.
        persistent = false;
      }
    },
  };
}
