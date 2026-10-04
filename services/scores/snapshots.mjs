import { COMPETITIONS } from "../../src/competitions.js";
import { isLive } from "../../src/format.js";
import { TERMINAL_MATCH_STATUSES } from "../../src/mapApiFootball.js";
import { hasStandings } from "../../src/standingsRecovery.js";
import { snapshotObservationTime } from "../../src/scoreSnapshot.js";

const MAX_BYTES = 2 * 1024 * 1024;
const preMatch = new Set(["TIMED", "SCHEDULED"]);
const validScore = score => Number.isInteger(score?.home) && score.home >= 0
  && Number.isInteger(score?.away) && score.away >= 0;

function timestamp(value, now) {
  if (!Number.isSafeInteger(value) || value < 0 || value > now + 1000) throw Error("Invalid observation time");
  return value;
}

// The storage adapter must atomically check the live lease and expected version
// before replacing a snapshot. Validation alone cannot fence another process.
export function nextSnapshot(previous, input, { epoch, now }) {
  if (!Object.hasOwn(COMPETITIONS, input.competition) || !/^\d{4}$/.test(String(input.season))) throw Error("Invalid competition or season");
  if (!Number.isSafeInteger(epoch) || epoch < 1 || !Number.isSafeInteger(now)) throw Error("Invalid writer generation");
  if (previous && (previous.competition !== input.competition || previous.season !== String(input.season)))
    throw Error("Snapshot identity changed");
  if (input.baseVersion !== (previous?.version ?? 0)) throw Error("Snapshot version conflict");
  if (previous && epoch < previous.collectorEpoch) throw Error("Writer generation moved backwards");
  if (!Array.isArray(input.fixtures) || input.fixtures.length > 2000) throw Error("A complete bounded fixture snapshot is required");
  timestamp(input.scheduleObservedAt, now);
  if (previous && input.scheduleObservedAt < previous.scheduleObservedAt) throw Error("Schedule observation moved backwards");
  const before = new Map((previous?.fixtures ?? []).map(row => [row.match.id, row]));
  const ids = new Set();
  for (const row of input.fixtures) {
    if (Buffer.byteLength(JSON.stringify(row)) > 32 * 1024) throw Error("Fixture exceeds storage limit");
    const m = row?.match;
    if (!Number.isSafeInteger(m?.id) || m.id < 1 || ids.has(m.id)
      || !Number.isFinite(Date.parse(m.utcDate)) || !m.homeTeam || !m.awayTeam
      || !(isLive(m.status) || TERMINAL_MATCH_STATUSES.has(m.status) || preMatch.has(m.status)))
      throw Error("Invalid fixture identity or status");
    if ((isLive(m.status) || ["FINISHED", "AWARDED"].includes(m.status)) && !validScore(m.score))
      throw Error("Started fixture has no valid score");
    ids.add(m.id);
    timestamp(row.observedAt, now);
    if (row.providerUpdatedAt != null) timestamp(row.providerUpdatedAt, now);
    const old = before.get(m.id);
    if (old && (row.observedAt < old.observedAt
      || (row.observedAt === old.observedAt && JSON.stringify(row) !== JSON.stringify(old))))
      throw Error("Fixture update is older than its stored observation");
  }
  // A partial or empty upstream response must not erase known games, including
  // historical results. A season rollover uses a separate storage identity.
  if ([...before.keys()].some(id => !ids.has(id))) throw Error("Snapshot lost expected fixtures");
  let standings = previous?.standings ?? { rows: [], observedAt: null, delayed: true };
  if (input.standings !== undefined) {
    const candidate = input.standings;
    const valid = hasStandings({ standings: candidate?.rows }) && Number.isSafeInteger(candidate.observedAt)
      && candidate.observedAt >= 0 && candidate.observedAt <= now + 1000
      && candidate.observedAt >= (standings.observedAt ?? 0)
      && Buffer.byteLength(JSON.stringify(candidate.rows)) <= 64 * 1024;
    // Supplementary table failure cannot reject an otherwise valid score update.
    standings = valid ? { rows: candidate.rows, observedAt: candidate.observedAt, delayed: false }
      : { ...standings, delayed: true };
  }
  const snapshot = { competition: input.competition, season: String(input.season), version: input.baseVersion + 1,
    collectorEpoch: epoch, publishedAt: now, scheduleObservedAt: input.scheduleObservedAt,
    fixtures: input.fixtures, standings };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_BYTES) throw Error("Snapshot exceeds storage limit");
  return structuredClone(snapshot);
}

export function scoreFeed(snapshot, now = Date.now()) {
  const matches = snapshot.fixtures.map(row => row.match);
  const metadata = { version: snapshot.version, collectorEpoch: snapshot.collectorEpoch,
    publishedAt: snapshot.publishedAt, scheduleObservedAt: snapshot.scheduleObservedAt,
    observations: snapshot.fixtures.map(({ match, observedAt, providerUpdatedAt = null }) => ({ id: match.id, observedAt, providerUpdatedAt })) };
  const active = snapshot.fixtures.filter(({ match }) => isLive(match.status)
    || (!TERMINAL_MATCH_STATUSES.has(match.status) && Date.parse(match.utcDate) <= now));
  const observedAt = snapshotObservationTime(matches, metadata, now);
  const ageMs = Math.max(0, now - observedAt);
  const stale = ageMs > (active.length ? 45000 : 6 * 3600000);
  const standingsAge = snapshot.standings.observedAt == null ? null : Math.max(0, now - snapshot.standings.observedAt);
  return {
    source: "stored-score-service", competition: snapshot.competition, season: snapshot.season,
    lastUpdated: new Date(observedAt).toISOString(), matches,
    standings: snapshot.standings.rows,
    standingsUpdatedAt: snapshot.standings.observedAt == null ? null : new Date(snapshot.standings.observedAt).toISOString(),
    standingsDelayed: snapshot.standings.delayed || standingsAge == null || standingsAge > 15 * 60000,
    ...(stale ? { stale: true, staleAgeMs: ageMs } : {}),
    snapshot: metadata,
  };
}

export function createScoreReadApi({ readSnapshot, seasons, now = Date.now }) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };
  const json = (body, status = 200) => Response.json(body, { status, headers });
  return async request => {
    const code = new URL(request.url).pathname.match(/^\/(PL|CL)\/live$/)?.[1];
    if (!code || !seasons[code]) return json({ error: "not found" }, 404);
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
    try {
      const snapshot = await readSnapshot(code, String(seasons[code]));
      if (!snapshot) return json({ competition: code, error: "scores not collected yet" }, 503);
      if (snapshot.competition !== code || snapshot.season !== String(seasons[code])) throw Error("Stored identity mismatch");
      return json(scoreFeed(snapshot, now()));
    } catch {
      return json({ competition: code, error: "stored scores unavailable" }, 503);
    }
  };
}
