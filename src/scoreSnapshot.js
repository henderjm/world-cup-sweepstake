const MAX_AGE = 24 * 60 * 60 * 1000;

export function validScoreSnapshot(raw, competition, now = Date.now()) {
  const age = now - Date.parse(raw?.lastUpdated);
  return raw?.competition === competition && !raw.error && Array.isArray(raw.matches)
    && raw.matches.length > 0 && Number.isFinite(age) && age >= -60000 && age <= MAX_AGE;
}

export function retainNewestScores(raw, competition) {
  const key = `gs-score-snapshot-${competition}`;
  try {
    const saved = JSON.parse(globalThis.localStorage.getItem(key));
    if (validScoreSnapshot(saved, competition) && (!validScoreSnapshot(raw, competition)
      || Date.parse(saved.lastUpdated) > Date.parse(raw.lastUpdated))) {
      return { ...saved, stale: true, staleAgeMs: Math.max(0, Date.now() - Date.parse(saved.lastUpdated)) };
    }
  } catch { /* Storage can be unavailable or contain an incomplete older write. */ }
  if (validScoreSnapshot(raw, competition)) {
    try { globalThis.localStorage.setItem(key, JSON.stringify(raw)); } catch { /* Scores remain usable without storage. */ }
  }
  return raw;
}
