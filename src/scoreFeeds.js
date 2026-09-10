import { COMPETITION_CODES, competitionFor } from "./competitions.js";

// Each competition owns its last good snapshot and request. A slow or failed
// league must not block the others or replace scores with an older static bake.
export function createScoreFeeds(load) {
  const feeds = new Map(COMPETITION_CODES.map(code => [code, {
    competition: competitionFor(code), hasData: false, loading: true,
  }]));
  const pending = new Map();
  return {
    get: code => feeds.get(code),
    values: () => [...feeds.values()],
    refresh(code) {
      if (pending.has(code)) return pending.get(code);
      const request = Promise.resolve().then(() => load(code)).catch(() => ({
        competition: competitionFor(code), hasData: false, error: "Scores are unavailable.",
      })).then(fresh => {
        const previous = feeds.get(code);
        const lost = fresh.error || (previous.hasData && (!fresh.hasData || Date.parse(fresh.lastUpdated) < Date.parse(previous.lastUpdated)));
        const next = lost && previous.hasData
          ? { ...previous, stale: true }
          : { ...fresh, fetchedAt: Date.now(), loading: false };
        feeds.set(code, next);
        return next;
      }).finally(() => pending.delete(code));
      pending.set(code, request);
      return request;
    },
  };
}

export function combinedScoreModel(feeds) {
  return {
    hasData: feeds.some(feed => feed.hasData),
    source: [...new Set(feeds.map(feed => feed.source).filter(Boolean))].join(" · "),
    matches: feeds.flatMap(feed => (feed.matches ?? []).map(match => ({
      ...match, competitionCode: feed.competition.code,
    }))),
  };
}
