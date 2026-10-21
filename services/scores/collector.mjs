import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { COMPETITIONS } from "../../src/competitions.js";
import { isLive } from "../../src/format.js";
import { mapApiFootballMatches, mapApiFootballStandingsPayload, TERMINAL_MATCH_STATUSES } from "../../src/mapApiFootball.js";
import { assertApiFootballPayload } from "../../src/apiFootballPayload.js";
import { hasStandings } from "../../src/standingsRecovery.js";
import { nextSnapshot } from "./snapshots.mjs";
import { detailJobs, validateDetailPayload } from "./detail-collector.mjs";
import { DETAIL_SECTIONS, detailKey, detailSubject } from "./details.mjs";
import { FantasyCollector } from "./fantasy-collector.mjs";
import { matchDetailCacheProfile } from "../../src/matchDetailCache.js";
import { normalizeSeasons } from "./config.mjs";

const DISCOVERY_MS = 15 * 60000;
const LIVE_MS = 15000;
const RETRY_MS = 30000;
// One malformed or vanished fixture used to fail its whole competition: a row
// that failed validation threw for the page, a batch missing one requested id
// threw for all twenty, and a known fixture absent from discovery failed every
// discovery for good ("Snapshot lost expected fixtures"). On 2026-10-20 that
// froze the Champions League feed from 15:21 UTC through the evening while the
// Premier League kept publishing, and the retry loops burned ~1,600 requests an
// hour. A FEW bad rows are now quarantined and a FEW vanished pre-match fixtures
// retired; more than this many at once is still treated as a broken response,
// which is what keeps a short or empty reply from erasing a season.
const MAX_QUARANTINED_ROWS = 3;
const MAX_RETIRED_FIXTURES = 3;
// An overdue fixture (kickoff passed, never seen live) must also be missing from
// this many consecutive id batches before discovery may retire it, so one
// incomplete discovery page cannot drop a match that is about to start.
const RETIRE_AFTER_BATCH_MISSES = 2;
const PRE_MATCH = new Set(["TIMED", "SCHEDULED"]);
// A detail section whose payload is MALFORMED (a lineup naming a player with
// no provider id, say; see malformed() in detail-collector.mjs) fails identically when fetched again 30s
// later, and current-match detail is admitted under the protected "scores"
// priority. On 2026-10-20 three matches' lineups and player stats failed this
// way every 30 seconds, roughly 700 wasted requests an hour, and the daily
// allowance ran out at 17:39 UTC with every match still in play: both
// competitions then froze until midnight. Request, storage and score-mismatch
// failures keep the short retry: those clear within a tick, and backing off a
// full-time mismatch would hold back the final result.
const DETAIL_VALIDATION_RETRY_MS = 5 * 60000;

export function scoreJobs(snapshots, seasons, now) {
  const jobs = [];
  for (const [competition, season] of Object.entries(seasons)) {
    const snapshot = snapshots[competition];
    const add = (kind, priority, due, ids = []) => jobs.push({ competition, season, kind, priority, due, ids,
      key: `${competition}:${kind}:${ids.join("-")}` });
    add("discovery", 1, snapshot ? snapshot.scheduleObservedAt + DISCOVERY_MS : 0);
    if (!snapshot) continue;
    const groups = { live: [], upcoming: [] };
    for (const row of snapshot.fixtures) {
      const match = row.match, kickoff = Date.parse(match.utcDate);
      if (TERMINAL_MATCH_STATUSES.has(match.status)) continue;
      if (isLive(match.status) || kickoff <= now) groups.live.push({ ...row, due: row.observedAt + LIVE_MS });
      else if (kickoff <= now + 2 * 3600000) groups.upcoming.push({ ...row, due: Math.min(row.observedAt + 15 * 60000, kickoff) });
    }
    for (const [kind, rows] of Object.entries(groups)) {
      rows.sort((a, b) => a.match.id - b.match.id);
      for (let i = 0; i < rows.length; i += 20) {
        const batch = rows.slice(i, i + 20);
        add(kind, kind === "live" ? 0 : 2, Math.min(...batch.map(row => row.due)), batch.map(row => row.match.id));
      }
    }
    add("standings", 3, snapshot.standings.observedAt == null ? 0 : snapshot.standings.observedAt + 15 * 60000);
  }
  return jobs;
}

function validatePage(payload, page) {
  assertApiFootballPayload(payload);
  if (payload.paging?.current !== page || !Number.isInteger(payload.paging.total)
    || payload.paging.total < page || payload.paging.total > 20 || payload.results !== payload.response.length
    || (payload.paging.total > 1 && !payload.response.length))
    throw Error("Incomplete or inconsistent provider page");
}

// Validates each provider row on its own. Returns the valid fixtures plus the
// ids of rows quarantined for being individually invalid. A response where
// every row is invalid, or more than MAX_QUARANTINED_ROWS are, is a wrong or
// broken response rather than a bad row, and still fails outright.
export function fixtureRows(payload, job, observedAt, epoch) {
  const fixtures = [], quarantined = [];
  for (const row of payload.response) {
    let reason = null;
    if (row.league?.id !== COMPETITIONS[job.competition].apiFootballLeagueId || String(row.league?.season) !== job.season
      || typeof row.teams?.home?.name !== "string" || !row.teams.home.name.trim()
      || typeof row.teams?.away?.name !== "string" || !row.teams.away.name.trim())
      reason = "Fixture competition, season or teams do not match discovery";
    const fixture = reason ? null : { match: mapApiFootballMatches({ response: [row] })[0], observedAt, providerUpdatedAt: null };
    if (fixture && fixture.match.status === "TIMED" && !["NS", "TBD"].includes(fixture.match.providerStatus))
      reason = "Unknown provider match status";
    if (fixture && !reason) {
      try {
        nextSnapshot(null, { competition: job.competition, season: job.season, baseVersion: 0,
          scheduleObservedAt: observedAt, fixtures: [fixture] }, { epoch, now: observedAt });
      } catch (error) { reason = error.message; }
    }
    if (!reason) { fixtures.push(fixture); continue; }
    if (payload.response.length === 1 || quarantined.length >= MAX_QUARANTINED_ROWS) throw Error(reason);
    quarantined.push(Number(row.fixture?.id) || null);
  }
  if (payload.response.length && !fixtures.length) throw Error("Every provider row was invalid");
  nextSnapshot(null, { competition: job.competition, season: job.season, baseVersion: 0,
    scheduleObservedAt: observedAt, fixtures }, { epoch, now: observedAt });
  return { fixtures, quarantined };
}

export class ScoreCollector {
  constructor({ store, provider, seasons, owner = randomUUID(), now = Date.now }) {
    this.store = store; this.provider = provider; this.owner = owner; this.now = now;
    this.seasons = normalizeSeasons(seasons);
    this.retryAt = new Map();
    this.discovery = new Map();
    this.details = new Map();
    this.batchMisses = new Map(); // fixture id -> consecutive id batches it was missing from
    this.epoch = null;
    this.fantasy = new FantasyCollector({ store, provider, now });
  }

  async step() {
    const lease = await this.store.claim(this.owner);
    if (!lease) return { state: "standby", retryAt: this.now() + 1000 };
    if (this.epoch !== lease.epoch) {
      this.fantasy.reset();
      this.details.clear(); this.discovery.clear(); this.retryAt.clear(); this.batchMisses.clear(); this.epoch = lease.epoch;
    }
    const snapshots = Object.fromEntries(await Promise.all(Object.entries(this.seasons)
      .map(async ([code, season]) => [code, await this.store.read(code, season)])));
    const now = this.now();
    const jobs = [...scoreJobs(snapshots, this.seasons, now), ...detailJobs(snapshots, this.seasons, this.details, now),
      ...this.fantasy.jobs(snapshots, this.seasons)];
    const keys = new Set(jobs.map(job => job.key));
    for (const key of this.retryAt.keys()) if (!keys.has(key)) this.retryAt.delete(key);
    for (const job of jobs) job.due = Math.max(job.due, this.retryAt.get(job.key) ?? 0);
    const job = jobs.filter(candidate => candidate.due <= now).sort((a, b) => a.priority - b.priority || a.due - b.due
      || a.key.localeCompare(b.key))[0];
    if (!job) return { state: "idle", retryAt: Math.min(...jobs.map(candidate => candidate.due)) };
    if (job.kind === "fantasy") {
      const event = await this.fantasy.collect(lease, job);
      if (event.retryAt) this.retryAt.set(job.key, event.retryAt);
      else this.retryAt.delete(job.key);
      return event;
    }
    if (job.kind === "detail") return this.collectDetail(lease, job);
    const previous = snapshots[job.competition];
    let discovery = this.discovery.get(job.competition);
    if (discovery && now - discovery.startedAt > 120000) { this.discovery.delete(job.competition); discovery = null; }
    const page = job.kind === "discovery" ? discovery?.page ?? 1 : 1;
    const league = COMPETITIONS[job.competition].apiFootballLeagueId;
    const path = job.kind === "standings" ? `/standings?league=${league}&season=${job.season}`
      : job.kind === "discovery" ? `/fixtures?league=${league}&season=${job.season}${page > 1 ? `&page=${page}` : ""}`
        : `/fixtures?ids=${job.ids.join("-")}`;
    let phase = "request";
    try {
      // The supplementary cap must not freeze the table shown beside live scores.
      const result = await this.provider.request(lease, path, { priority: "scores" });
      if (!result.allowed) {
        this.retryAt.set(job.key, result.retryAt);
        return { state: "deferred", competition: job.competition, kind: job.kind, reason: result.reason, retryAt: result.retryAt };
      }
      phase = "validation";
      const { payload, observedAt } = result;
      validatePage(payload, page);
      const input = { competition: job.competition, season: job.season, baseVersion: previous?.version ?? 0,
        scheduleObservedAt: previous?.scheduleObservedAt ?? observedAt, fixtures: previous?.fixtures ?? [] };
      if (job.kind === "standings") {
        if (payload.paging.total !== 1 || payload.response.some(row => row.league?.id !== league || String(row.league?.season) !== job.season))
          throw Error("Incomplete or mismatched standings");
        const tables = payload.response.flatMap(row => row.league.standings ?? []);
        if (!tables.length || tables.some(table => !Array.isArray(table) || !table.length || table.some(row =>
          !Number.isSafeInteger(row.team?.id) || row.team.id < 1 || typeof row.team.name !== "string" || !row.team.name.trim()
          || !Number.isInteger(row.rank) || row.rank < 1 || !Number.isInteger(row.points) || !Number.isInteger(row.goalsDiff)
          || ![row.all?.played, row.all?.win, row.all?.draw, row.all?.lose, row.all?.goals?.for, row.all?.goals?.against]
            .every(value => Number.isInteger(value) && value >= 0)))) throw Error("Incomplete standings rows");
        const rows = mapApiFootballStandingsPayload(payload);
        if (!hasStandings({ standings: rows })) throw Error("Standings unavailable");
        const teams = new Set(rows.flatMap(group => group.table.map(row => row.team.id)));
        if (previous.standings.rows.some(group => group.table.some(row => !teams.has(row.team.id)))) throw Error("Standings lost expected teams");
        input.standings = { rows, observedAt };
      } else {
        const { fixtures: rows, quarantined } = fixtureRows(payload, job, observedAt, lease.epoch);
        if (job.kind === "discovery") {
          discovery ??= { startedAt: observedAt, page: 1, total: payload.paging.total, rows: [], quarantined: [] };
          if (payload.paging.total !== discovery.total || discovery.rows.length + rows.length > 2000)
            throw Error("Discovery pagination changed or exceeds fixture bound");
          discovery.rows.push(...rows);
          discovery.quarantined.push(...quarantined);
          if (discovery.quarantined.length > MAX_QUARANTINED_ROWS) throw Error("Too many invalid discovery rows");
          if (new Set(discovery.rows.map(row => row.match.id)).size !== discovery.rows.length) throw Error("Duplicate discovery fixture");
          if (page < discovery.total) {
            discovery.page++;
            this.discovery.set(job.competition, discovery);
            return { state: "discovering", competition: job.competition, page };
          }
          const known = new Map(input.fixtures.map(row => [row.match.id, row]));
          input.fixtures = discovery.rows.map(row => known.get(row.match.id)?.observedAt > row.observedAt ? known.get(row.match.id) : row);
          // A known fixture whose row was quarantined keeps its stored row.
          const seen = new Set(input.fixtures.map(row => row.match.id));
          for (const id of discovery.quarantined) if (known.has(id) && !seen.has(id)) { input.fixtures.push(known.get(id)); seen.add(id); }
          const absent = [...known.values()].filter(row => !seen.has(row.match.id));
          const retirable = absent.filter(row => PRE_MATCH.has(row.match.status)
            && (Date.parse(row.match.utcDate) > observedAt || (this.batchMisses.get(row.match.id) ?? 0) >= RETIRE_AFTER_BATCH_MISSES));
          if (retirable.length !== absent.length || retirable.length > MAX_RETIRED_FIXTURES)
            throw Error("Snapshot lost expected fixtures");
          if (retirable.length) input.removedIds = retirable.map(row => row.match.id);
          input.scheduleObservedAt = discovery.startedAt;
        } else {
          // A batch answers for what it returned. A requested fixture it left out
          // keeps its last observation and is counted as missing, so discovery
          // can retire it if the provider has really dropped it. An EMPTY answer
          // is a throttled or failed read, not twenty vanished matches.
          if (payload.paging.total !== 1 || !rows.length || rows.some(row => !job.ids.includes(row.match.id)))
            throw Error("Live batch returned no or unrequested fixtures");
          const updates = new Map(rows.map(row => [row.match.id, row]));
          for (const id of job.ids) {
            if (updates.has(id)) this.batchMisses.delete(id);
            else this.batchMisses.set(id, (this.batchMisses.get(id) ?? 0) + 1);
          }
          input.fixtures = input.fixtures.map(row => updates.get(row.match.id) ?? row);
        }
      }
      phase = "publication";
      await this.store.publish(lease, input);
      const detailFailures = job.ids.length
        ? await this.collectEmbeddedDetails(lease, job, payload, observedAt) : [];
      if (job.kind === "discovery") this.discovery.delete(job.competition);
      const missing = job.ids.filter(id => !payload.response.some(row => row.fixture?.id === id));
      // A fixture the batch left out keeps its old observation, which would make
      // its batch permanently overdue: re-polled every step at the highest
      // priority, starving later live batches and discovery (the step that can
      // retire it) while spending a request each time. Poll it on the normal cadence.
      if (missing.length) this.retryAt.set(job.key, observedAt + LIVE_MS);
      else this.retryAt.delete(job.key);
      for (const id of input.removedIds ?? []) this.batchMisses.delete(id);
      return { state: "published", competition: job.competition, kind: job.kind, version: input.baseVersion + 1,
        ...(detailFailures.length ? { detailFailures } : {}), ...(missing.length ? { missing } : {}),
        ...(input.removedIds ? { retired: input.removedIds } : {}) };
    } catch (error) {
      if (job.kind === "discovery") this.discovery.delete(job.competition);
      const retryAt = this.now() + RETRY_MS;
      this.retryAt.set(job.key, retryAt);
      // The message, bounded, is what tells a refused request from a validation
      // rule from a storage conflict; the bare error name ("Error") did not.
      return { state: "failed", competition: job.competition, kind: job.kind, phase, error: error.name,
        message: String(error.message ?? "").slice(0, 160), retryAt };
    }
  }

  async collectEmbeddedDetails(lease, job, payload, observedAt) {
    const failures = [];
    for (const row of payload.response) {
      if (!["events", "lineups", "players"].some(name => Array.isArray(row[name]))) continue;
      const match = mapApiFootballMatches({ response: [row] })[0];
      const key = detailKey(job.competition, job.season, match.id);
      let stored;
      try { stored = await this.store.readDetail(job.competition, job.season, match.id); }
      catch { failures.push({ id: match.id, error: "Stored detail unavailable" }); continue; }
      for (const section of DETAIL_SECTIONS) {
        if (section !== "fixture" && !Array.isArray(row[section])) continue;
        const previous = stored?.sections[section];
        const subject = detailSubject(match);
        if (previous?.subject === subject && previous.coverage === "complete"
          && observedAt - previous.observedAt < Math.min(45000, matchDetailCacheProfile(match, observedAt)[section] * 1000)) continue;
        const detailPayload = { errors: [], paging: { current: 1, total: 1 },
          response: section === "fixture" ? [{ ...row, events: undefined, lineups: undefined,
            players: undefined, statistics: undefined }] : row[section] };
        detailPayload.results = detailPayload.response.length;
        try {
          // Scores have already committed. Invalid embedded detail must not roll them back.
          if (this.now() + 15000 >= lease.expiresAt) {
            const renewed = await this.store.claim(this.owner);
            if (!renewed || renewed.epoch !== lease.epoch) throw Error("Collector lease lost");
            lease = renewed;
          }
          const coverage = validateDetailPayload(detailPayload, { ...job, match, section }, stored);
          if (coverage !== "complete" && previous?.coverage === "complete") continue;
          const manifest = await this.store.publishDetail(lease, { competition: job.competition, season: job.season,
            id: match.id, section, baseVersion: stored?.version ?? 0, payload: detailPayload,
            observedAt, subject, coverage });
          stored = { ...manifest, payloads: { ...stored?.payloads, [section]: detailPayload } };
          this.details.set(key, manifest);
          this.retryAt.delete(`${key}:${section}:scores`);
        } catch (error) {
          failures.push({ id: match.id, section, error: error.message });
        }
      }
    }
    return failures;
  }

  async collectDetail(lease, job) {
    let phase = "read";
    try {
      if (job.section === "hydrate") {
        this.details.set(job.detailKey, await this.store.readDetailManifest(job.competition, job.season, job.match.id));
        return { state: "hydrated", kind: "detail", competition: job.competition, id: job.match.id };
      }
      const stored = await this.store.readDetail(job.competition, job.season, job.match.id);
      const path = job.section === "fixture" ? `/fixtures?ids=${job.match.id}` : `/fixtures/${job.section}?fixture=${job.match.id}`;
      phase = "request";
      const result = await this.provider.request(lease, path, { priority: job.admission });
      if (!result.allowed) {
        this.retryAt.set(job.key, result.retryAt);
        return { state: "deferred", kind: "detail", section: job.section, competition: job.competition,
          reason: result.reason, retryAt: result.retryAt };
      }
      phase = "validation";
      const coverage = validateDetailPayload(result.payload, job, stored);
      if (coverage !== "complete" && stored?.sections[job.section]?.coverage === "complete")
        throw Error("Incomplete detail would replace last-good coverage");
      phase = "publication";
      const payload = job.section === "fixture" ? { ...result.payload, response: result.payload.response.map(row => ({
        ...row, events: undefined, lineups: undefined, players: undefined, statistics: undefined })) } : result.payload;
      const manifest = await this.store.publishDetail(lease, { competition: job.competition, season: job.season,
        id: job.match.id, section: job.section, baseVersion: stored?.version ?? 0, payload,
        observedAt: result.observedAt, subject: detailSubject(job.match), coverage });
      this.details.set(job.detailKey, manifest);
      const detailFailures = job.section === "fixture"
        ? await this.collectEmbeddedDetails(lease, job, result.payload, result.observedAt) : [];
      this.retryAt.delete(job.key);
      return { state: "published", kind: "detail", section: job.section, competition: job.competition,
        id: job.match.id, coverage, version: manifest.version, ...(detailFailures.length ? { detailFailures } : {}) };
    } catch (error) {
      if (phase === "publication") this.details.delete(job.detailKey);
      const retryAt = this.now() + (job.admission === "supplementary" ? 15 * 60000
        : error.name === "MalformedDetailPayload" ? DETAIL_VALIDATION_RETRY_MS : RETRY_MS);
      this.retryAt.set(job.key, retryAt);
      return { state: "failed", id: job.match.id, kind: "detail", section: job.section, competition: job.competition,
        phase, error: error.name, message: String(error.message ?? "").slice(0, 160), retryAt };
    }
  }

  async run({ signal, onEvent = () => {} }) {
    while (!signal.aborted) {
      let event;
      try { event = await this.step(); }
      catch (error) { event = { state: "unavailable", error: error.name, retryAt: this.now() + 5000 }; }
      onEvent(event);
      // Rebuild the queue from stored observations after every action and wake
      // frequently enough to renew the lease even during a long idle period.
      try { await sleep(Math.min(5000, Math.max(100, (event.retryAt ?? this.now()) - this.now())), undefined, { signal }); }
      catch (error) { if (error.name !== "AbortError") throw error; }
    }
  }
}
