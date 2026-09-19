import { competitionFor } from "./competitions.js";
import { isFinished, isLive } from "./format.js";

export const hasStandings = raw => Array.isArray(raw?.standings) && raw.standings.some(group =>
  group?.type === "TOTAL" && Array.isArray(group.table) && group.table.length
  && group.table.every(row => typeof (row?.team?.shortName ?? row?.team?.name) === "string"
    && Number.isFinite(row?.points) && Number.isFinite(row?.playedGames)));
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const tableTimestamp = candidate => candidate?.standingsUpdatedAt ?? candidate?.lastUpdated;

export function createStandingsRecovery(loadFallback) {
  const saved = new Map();
  return async (raw, competition) => {
    if (raw.error || raw.competition !== competition) return raw;
    const key = `gs-standings-${competition}`;
    const remember = candidate => {
      const snapshot = { competition, season: candidate.season, lastUpdated: tableTimestamp(candidate), standings: candidate.standings };
      saved.set(competition, snapshot);
      try { globalThis.localStorage.setItem(key, JSON.stringify(snapshot)); } catch { /* Keep the in-memory copy when storage is blocked. */ }
    };
    const valid = candidate => {
      const age = Date.now() - Date.parse(tableTimestamp(candidate));
      return raw.season != null && candidate?.season === raw.season && candidate.competition === competition
        && !candidate.error && hasStandings(candidate) && Number.isFinite(age) && age >= -60000 && age <= MAX_AGE;
    };
    if (hasStandings(raw) && (!raw.standingsDelayed || valid(raw))) {
      if (valid(raw)) remember(raw);
      return raw;
    }
    raw = { ...raw, standings: [], standingsDelayed: false, standingsUpdatedAt: null };
    let previous = saved.get(competition);
    try {
      const stored = JSON.parse(globalThis.localStorage.getItem(key));
      if (valid(stored) && (!valid(previous) || Date.parse(stored.lastUpdated) > Date.parse(previous.lastUpdated))) previous = stored;
    } catch { /* A missing or corrupt saved table must not block scores. */ }
    const phases = competitionFor(competition).standingsStages;
    const started = (raw.matches ?? []).some(match => (!phases || phases.includes(match.stage)) && (isLive(match.status) || isFinished(match.status)));
    if (!valid(previous) && started && raw.season != null) {
      try { previous = await loadFallback(competition); } catch { previous = null; }
    }
    if (valid(previous)) {
      remember(previous);
      return { ...raw, standings: previous.standings, standingsDelayed: true, standingsUpdatedAt: tableTimestamp(previous) };
    }
    return { ...raw, standingsUnavailable: started };
  };
}
