import { isLive } from "./format.js";
import { TERMINAL_MATCH_STATUSES } from "./mapApiFootball.js";

const MAX_AGE = 24 * 60 * 60 * 1000;

function versioned(raw) {
  const valid = raw?.source === "stored-score-service" && typeof raw.season === "string"
    && Number.isSafeInteger(raw.snapshot?.version) && raw.snapshot.version > 0
    && Number.isSafeInteger(raw.snapshot?.publishedAt) && raw.snapshot.publishedAt >= 0
    && Number.isSafeInteger(raw.snapshot?.scheduleObservedAt)
    && Array.isArray(raw.snapshot?.observations)
    && raw.snapshot.observations.every(row => Number.isSafeInteger(row?.id) && row.id > 0
      && Number.isSafeInteger(row.observedAt) && row.observedAt >= 0);
  if (!valid || !Array.isArray(raw.matches)) return false;
  const ids = new Set(raw.snapshot.observations.map(row => row.id));
  return ids.size === raw.snapshot.observations.length && ids.size === raw.matches.length
    && raw.matches.every(match => ids.has(match?.id));
}

export function snapshotObservationTime(matches, snapshot, now) {
  const observations = new Map(snapshot.observations.map(row => [row.id, row.observedAt]));
  const active = matches.filter(match => isLive(match.status)
    || (!TERMINAL_MATCH_STATUSES.has(match.status) && Date.parse(match.utcDate) <= now));
  return active.length ? Math.min(...active.map(match => observations.get(match.id))) : snapshot.scheduleObservedAt;
}

export function validScoreSnapshot(raw, competition, now = Date.now()) {
  if (raw?.source === "stored-score-service" && !versioned(raw)) return false;
  const sourceTime = Date.parse(raw?.lastUpdated);
  const age = now - (versioned(raw) ? raw.snapshot.publishedAt : sourceTime);
  return raw?.competition === competition && !raw.error && Array.isArray(raw.matches)
    && raw.matches.length > 0 && Number.isFinite(sourceTime) && sourceTime <= now + 60000
    && Number.isFinite(age) && age >= -60000 && age <= MAX_AGE
    && (!versioned(raw) || Number.isFinite(snapshotObservationTime(raw.matches, raw.snapshot, now)));
}

export function retainNewestScores(raw, competition) {
  const key = `gs-score-snapshot-${competition}`;
  try {
    const saved = JSON.parse(globalThis.localStorage.getItem(key));
    // Aggregate age can go backwards when another game becomes overdue. The
    // stored version orders publications without pretending that game is fresh.
    const savedIsNewer = versioned(saved) && versioned(raw) && saved.season === raw.season
      ? saved.snapshot.version > raw.snapshot.version
      : Date.parse(saved?.lastUpdated) > Date.parse(raw?.lastUpdated);
    if (validScoreSnapshot(saved, competition) && (!validScoreSnapshot(raw, competition)
      || savedIsNewer)) {
      const observedAt = versioned(saved) ? snapshotObservationTime(saved.matches, saved.snapshot, Date.now()) : Date.parse(saved.lastUpdated);
      return { ...saved, stale: true, staleAgeMs: Math.max(0, Date.now() - observedAt) };
    }
  } catch { /* Storage can be unavailable or contain an incomplete older write. */ }
  if (validScoreSnapshot(raw, competition)) {
    try { globalThis.localStorage.setItem(key, JSON.stringify(raw)); } catch { /* Scores remain usable without storage. */ }
  }
  return raw;
}
