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
    const origin = new URL(configuredOrigin);
    if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/"
      || !(origin.protocol === "https:" || (origin.protocol === "http:" && ["127.0.0.1", "localhost"].includes(origin.hostname))))
      throw Error("Invalid stored score origin");
    const key = `${origin.origin}/${comp.code}/${comp.season}`;
    let request = inflight.get(key);
    if (!request) {
      request = (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let reader;
        try {
          const response = await fetcher(`${origin.origin}/${encodeURIComponent(comp.code)}/live`, {
            signal: controller.signal, redirect: "error", headers: { Accept: "application/json" },
          });
          if (!response.ok) throw Error("Stored scores unavailable");
          reader = response.body?.getReader();
          if (!reader) throw Error("Stored scores have no body");
          const chunks = []; let size = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 4 * 1024 * 1024) throw Error("Stored scores exceed read limit");
            chunks.push(value);
          }
          const bytes = new Uint8Array(size); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          const body = validate(JSON.parse(new TextDecoder().decode(bytes)), comp, now());
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
        } finally {
          clearTimeout(timer); controller.abort(); await reader?.cancel().catch(() => {});
        }
      })().finally(() => inflight.delete(key));
      inflight.set(key, request);
    }
    return structuredClone(await request);
  };
}
