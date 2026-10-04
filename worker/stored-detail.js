import { storedOrigin, fetchStoredJson } from "./stored-read.js";
import { matchDetailCacheProfile } from "../src/matchDetailCache.js";
import { TERMINAL_MATCH_STATUSES } from "../src/mapApiFootball.js";
import { isLive } from "../src/format.js";

const sections = ["fixture", "lineups", "events", "players"];
const family = name => name === "fixture" ? "/fixtures" : `/fixtures/${name}`;
const positive = value => Number.isSafeInteger(value) && value > 0;
const states = new Set(["complete", "partial", "unpublished", "missing", "invalid", "stale", "outdated-result"]);

function validate(body, comp, id, now) {
  const meta = body?.snapshot;
  if (body?.source !== "stored-score-service" || body.error || body.id !== id || body.competition !== comp.code
    || body.season !== String(comp.season) || !positive(meta?.version) || !positive(meta.collectorEpoch)
    || !Number.isSafeInteger(meta.observedAt) || meta.observedAt < 0 || meta.observedAt > now + 1000
    || !((meta.detailVersion === null && meta.detailCollectorEpoch === null)
      || (positive(meta.detailVersion) && positive(meta.detailCollectorEpoch)))
    || typeof body.home?.name !== "string" || !body.home.name || typeof body.away?.name !== "string" || !body.away.name
    || !Number.isFinite(Date.parse(body.utcDate)) || !(isLive(body.status) || ["TIMED", "SCHEDULED"].includes(body.status) || TERMINAL_MATCH_STATUSES.has(body.status))
    || !["goals", "cards", "subs", "playerStats", "degraded"].every(name => Array.isArray(body[name]))
    || ![body.home.lineup, body.home.bench, body.away.lineup, body.away.bench].every(Array.isArray)
    || !body.score || ![body.score.home, body.score.away].every(value => value === null || (Number.isInteger(value) && value >= 0)))
    throw Error("Invalid stored match detail");
  if ((isLive(body.status) || ["FINISHED", "AWARDED"].includes(body.status))
    && ![body.score.home, body.score.away].every(value => Number.isInteger(value) && value >= 0)) throw Error("Invalid stored detail score");
  for (const name of sections) {
    const section = body.coverage?.[name];
    if (!states.has(section?.state) || !(section.observedAt === null ? section.state === "missing"
      : Number.isSafeInteger(section.observedAt) && section.observedAt >= 0 && section.observedAt <= now + 1000))
      throw Error("Invalid detail observation");
  }
  return body;
}

function aged(body, now, failed = false) {
  const result = structuredClone(body), profile = matchDetailCacheProfile(body, now);
  const degraded = new Set(result.degraded);
  for (const name of sections) {
    const section = result.coverage[name];
    section.ageMs = section.observedAt === null ? null : Math.max(0, now - section.observedAt);
    if (section.state === "complete" && section.ageMs >= profile[name] * 1000) section.state = "stale";
    if (failed || section.state !== "complete") degraded.add(family(name));
  }
  const active = isLive(body.status) || (["TIMED", "SCHEDULED"].includes(body.status) && Date.parse(body.utcDate) <= now);
  result.staleAgeMs = Math.max(0, now - body.snapshot.observedAt);
  result.stale = failed || body.stale || result.staleAgeMs > (active ? 45000 : 6 * 3600000);
  if (result.stale) degraded.add("/fixtures");
  result.degraded = [...degraded];
  return result;
}

export function createStoredDetailReader({ fetcher = (...args) => fetch(...args), now = Date.now, timeoutMs = 4000 } = {}) {
  const saved = new Map(), inflight = new Map();
  let savedBytes = 0;
  return async function read(comp, id, configuredOrigin) {
    if (!positive(id)) throw Error("Invalid fixture id");
    const origin = storedOrigin(configuredOrigin);
    const key = `${origin}/${comp.code}/${comp.season}/${id}`;
    if (!inflight.has(key)) {
      if (inflight.size >= 32) throw Error("Stored detail capacity exceeded");
      const pending = (async () => {
        try {
          const result = await fetchStoredJson(`${origin}/${encodeURIComponent(comp.code)}/match/${id}`, { fetcher, timeoutMs, maxBytes: 1024 * 1024 });
          const { size } = result;
          const body = validate(result.body, comp, id, now());
          const previous = saved.get(key)?.body;
          if (previous && ["version", "collectorEpoch", "detailVersion", "detailCollectorEpoch"].some(name =>
            (body.snapshot[name] ?? 0) < (previous.snapshot[name] ?? 0))) throw Error("Stored detail regressed");
          savedBytes -= saved.get(key)?.size ?? 0;
          saved.delete(key); saved.set(key, { body, size }); savedBytes += size;
          while (savedBytes > 4 * 1024 * 1024 || saved.size > 32) {
            const first = saved.keys().next().value; savedBytes -= saved.get(first).size; saved.delete(first);
          }
          return aged(body, now());
        } catch (error) {
          const previous = saved.get(key)?.body;
          if (previous) return aged(previous, now(), true);
          throw error;
        }
      })().finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    return structuredClone(await inflight.get(key));
  };
}
