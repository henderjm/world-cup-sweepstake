import { storedOrigin, fetchStoredJson } from "./stored-read.js";
import { isLive } from "../src/format.js";
import { TERMINAL_MATCH_STATUSES } from "../src/mapApiFootball.js";
import { snapshotObservationTime } from "../src/scoreSnapshot.js";

const preMatch = new Set(["TIMED", "SCHEDULED"]);
const validTime = (value, now) => Number.isSafeInteger(value) && value >= 0 && value <= now + 1000;

function validate(body, comp, now) {
  const snapshot = body?.snapshot;
  if (body?.source !== "stored-score-service" || body.error || body.competition !== comp.code
    || body.season !== String(comp.season) || !Array.isArray(body.matches) || body.matches.length > 2000
    || !Array.isArray(body.standings) || !Number.isSafeInteger(snapshot?.version) || snapshot.version < 1
    || !Number.isSafeInteger(snapshot.collectorEpoch) || snapshot.collectorEpoch < 1
    || !validTime(snapshot.publishedAt, now) || !validTime(snapshot.scheduleObservedAt, now)
    || !Array.isArray(snapshot.observations) || snapshot.observations.length !== body.matches.length)
    throw Error("Invalid stored score snapshot");
  const observations = new Map();
  for (const row of snapshot.observations) {
    if (!Number.isSafeInteger(row?.id) || row.id < 1 || observations.has(row.id)
      || !validTime(row.observedAt, now)) throw Error("Invalid stored score observation");
    observations.set(row.id, row);
  }
  const ids = new Set();
  for (const match of body.matches) {
    if (!observations.has(match?.id) || ids.has(match.id) || !Number.isFinite(Date.parse(match.utcDate))
      || !match.homeTeam || !match.awayTeam
      || !(isLive(match.status) || preMatch.has(match.status) || TERMINAL_MATCH_STATUSES.has(match.status)))
      throw Error("Invalid stored fixture");
    if ((isLive(match.status) || ["FINISHED", "AWARDED"].includes(match.status))
      && ![match.score?.home, match.score?.away].every(value => Number.isInteger(value) && value >= 0))
      throw Error("Invalid stored score");
    ids.add(match.id);
  }
  return body;
}

function age(body, now, failed = false) {
  const observedAt = snapshotObservationTime(body.matches, body.snapshot, now);
  const ageMs = Math.max(0, now - observedAt);
  const active = body.matches.some(match => isLive(match.status)
    || (!TERMINAL_MATCH_STATUSES.has(match.status) && Date.parse(match.utcDate) <= now));
  return { ...structuredClone(body), lastUpdated: new Date(observedAt).toISOString(),
    stale: failed || Boolean(body.stale) || ageMs > (active ? 45000 : 6 * 3600000), staleAgeMs: ageMs };
}

export function createStoredScoreReader({ fetcher = (...args) => fetch(...args), now = Date.now, timeoutMs = 4000 } = {}) {
  const saved = new Map(), inflight = new Map();
  return async function read(comp, configuredOrigin) {
    const origin = storedOrigin(configuredOrigin);
    const key = `${origin}/${comp.code}/${comp.season}`;
    let request = inflight.get(key);
    if (!request) {
      request = (async () => {
        try {
          const result = await fetchStoredJson(`${origin}/${encodeURIComponent(comp.code)}/live`, { fetcher, timeoutMs, maxBytes: 4 * 1024 * 1024 });
          const body = validate(result.body, comp, now());
          const previous = saved.get(key);
          const ids = new Set(body.matches.map(match => match.id));
          if (previous && (body.snapshot.version < previous.snapshot.version
            || body.snapshot.collectorEpoch < previous.snapshot.collectorEpoch
            || previous.matches.some(match => !ids.has(match.id))))
            throw Error("Stored score snapshot regressed");
          saved.set(key, body);
          if (saved.size > 4) saved.delete(saved.keys().next().value);
          return age(body, now());
        } catch (error) {
          const previous = saved.get(key);
          if (previous) return age(previous, now(), true);
          throw error;
        }
      })().finally(() => inflight.delete(key));
      inflight.set(key, request);
    }
    return structuredClone(await request);
  };
}
