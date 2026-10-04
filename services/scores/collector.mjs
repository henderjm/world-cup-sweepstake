import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { COMPETITIONS } from "../../src/competitions.js";
import { isLive } from "../../src/format.js";
import { mapApiFootballMatches, mapApiFootballStandingsPayload, TERMINAL_MATCH_STATUSES } from "../../src/mapApiFootball.js";
import { assertApiFootballPayload } from "../../src/apiFootballPayload.js";
import { hasStandings } from "../../src/standingsRecovery.js";
import { nextSnapshot } from "./snapshots.mjs";
import { detailJobs, validateDetailPayload } from "./detail-collector.mjs";
import { detailSubject } from "./details.mjs";
import { FantasyCollector } from "./fantasy-collector.mjs";
import { normalizeSeasons } from "./config.mjs";

const DISCOVERY_MS = 15 * 60000;
const LIVE_MS = 15000;
const RETRY_MS = 30000;

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

function fixtureRows(payload, job, observedAt, epoch) {
  if (payload.response.some(row => row.league?.id !== COMPETITIONS[job.competition].apiFootballLeagueId
    || String(row.league?.season) !== job.season || typeof row.teams?.home?.name !== "string"
    || !row.teams.home.name.trim() || typeof row.teams?.away?.name !== "string" || !row.teams.away.name.trim()))
    throw Error("Fixture competition, season or teams do not match discovery");
  const fixtures = mapApiFootballMatches(payload).map(match => ({ match, observedAt, providerUpdatedAt: null }));
  if (fixtures.some(row => row.match.status === "TIMED" && !["NS", "TBD"].includes(row.match.providerStatus)))
    throw Error("Unknown provider match status");
  nextSnapshot(null, { competition: job.competition, season: job.season, baseVersion: 0,
    scheduleObservedAt: observedAt, fixtures }, { epoch, now: observedAt });
  return fixtures;
}

export class ScoreCollector {
  constructor({ store, provider, seasons, owner = randomUUID(), now = Date.now }) {
    this.store = store; this.provider = provider; this.owner = owner; this.now = now;
    this.seasons = normalizeSeasons(seasons);
    this.retryAt = new Map();
    this.discovery = new Map();
    this.details = new Map();
    this.epoch = null;
    this.fantasy = new FantasyCollector({ store, provider, now });
  }

  async step() {
    const lease = await this.store.claim(this.owner);
    if (!lease) return { state: "standby", retryAt: this.now() + 1000 };
    if (this.epoch !== lease.epoch) {
      this.fantasy.reset();
      this.details.clear(); this.discovery.clear(); this.retryAt.clear(); this.epoch = lease.epoch;
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
      const result = await this.provider.request(lease, path, { priority: job.kind === "standings" ? "supplementary" : "scores" });
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
        const rows = fixtureRows(payload, job, observedAt, lease.epoch);
        if (job.kind === "discovery") {
          discovery ??= { startedAt: observedAt, page: 1, total: payload.paging.total, rows: [] };
          if (payload.paging.total !== discovery.total || discovery.rows.length + rows.length > 2000)
            throw Error("Discovery pagination changed or exceeds fixture bound");
          discovery.rows.push(...rows);
          if (new Set(discovery.rows.map(row => row.match.id)).size !== discovery.rows.length) throw Error("Duplicate discovery fixture");
          if (page < discovery.total) {
            discovery.page++;
            this.discovery.set(job.competition, discovery);
            return { state: "discovering", competition: job.competition, page };
          }
          const known = new Map(input.fixtures.map(row => [row.match.id, row]));
          input.fixtures = discovery.rows.map(row => known.get(row.match.id)?.observedAt > row.observedAt ? known.get(row.match.id) : row);
          input.scheduleObservedAt = discovery.startedAt;
        } else {
          if (payload.paging.total !== 1 || rows.length !== job.ids.length || rows.some(row => !job.ids.includes(row.match.id)))
            throw Error("Live batch did not return every requested fixture");
          const updates = new Map(rows.map(row => [row.match.id, row]));
          input.fixtures = input.fixtures.map(row => updates.get(row.match.id) ?? row);
        }
      }
      phase = "publication";
      await this.store.publish(lease, input);
      if (job.kind === "discovery") this.discovery.delete(job.competition);
      this.retryAt.delete(job.key);
      return { state: "published", competition: job.competition, kind: job.kind, version: input.baseVersion + 1 };
    } catch (error) {
      if (job.kind === "discovery") this.discovery.delete(job.competition);
      const retryAt = this.now() + RETRY_MS;
      this.retryAt.set(job.key, retryAt);
      return { state: "failed", competition: job.competition, kind: job.kind, phase, error: error.name, retryAt };
    }
  }

  async collectDetail(lease, job) {
    let phase = "read";
    try {
      if (job.section === "hydrate") {
        this.details.set(job.detailKey, await this.store.readDetailManifest(job.competition, job.season, job.match.id));
        return { state: "hydrated", kind: "detail", competition: job.competition, id: job.match.id };
      }
      const stored = await this.store.readDetail(job.competition, job.season, job.match.id);
      const path = job.section === "fixture" ? `/fixtures?id=${job.match.id}` : `/fixtures/${job.section}?fixture=${job.match.id}`;
      phase = "request";
      const result = await this.provider.request(lease, path, { priority: "supplementary" });
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
      const manifest = await this.store.publishDetail(lease, { competition: job.competition, season: job.season,
        id: job.match.id, section: job.section, baseVersion: stored?.version ?? 0, payload: result.payload,
        observedAt: result.observedAt, subject: detailSubject(job.match), coverage });
      this.details.set(job.detailKey, manifest);
      this.retryAt.delete(job.key);
      return { state: "published", kind: "detail", section: job.section, competition: job.competition,
        id: job.match.id, coverage, version: manifest.version };
    } catch (error) {
      if (phase === "publication") this.details.delete(job.detailKey);
      const retryAt = this.now() + RETRY_MS;
      this.retryAt.set(job.key, retryAt);
      return { state: "failed", kind: "detail", section: job.section, competition: job.competition,
        phase, error: error.name, retryAt };
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
