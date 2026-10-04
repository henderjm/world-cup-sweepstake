import { COMPETITIONS } from '../../src/competitions.js';
import { previousSeasonsFor, buildPriorSeasonStatsIndex, buildPlayerClubAppearances } from '../../src/fantasyPlayerTier.js';
import { squadPlayers, validateHistoryPage, historyCleanSheetRates } from './fantasy-data.mjs';
import { fantasyKey } from './fantasy-store.mjs';

const DAY = 86400000;
const RETRY = 5 * 60000;

export class FantasyCollector {
  constructor({ store, provider, now = Date.now }) {
    this.store = store; this.provider = provider; this.now = now;
    this.manifests = new Map(); this.runs = new Map();
  }

  reset() { this.manifests.clear(); this.runs.clear(); }

  jobs(snapshots, seasons) {
    // Only PL has an existing fantasy player-pool bake to replace.
    const season = seasons.PL, snapshot = snapshots.PL;
    if (!season || !snapshot) return [];
    const clubs = [...new Map(snapshot.standings.rows.flatMap(group => group.table.map(row => [row.team.id, row.team]))).values()]
      .sort((a, b) => a.id - b.id);
    const entries = [...(clubs.length ? [{ season, dataset: 'squads', clubs, priority: 5, interval: DAY }] : []),
      ...previousSeasonsFor(season, 3).map((season, index) => ({ season, dataset: 'history', priority: 7 + index, interval: 7 * DAY }))];
    const jobs = entries.map(entry => {
      const key = fantasyKey('PL', entry.season, entry.dataset), manifest = this.manifests.get(key);
      return { ...entry, competition: 'PL', kind: 'fantasy', key,
        due: this.runs.has(key) || !manifest ? 0 : manifest.observedAt + entry.interval };
    });
    const keys = new Set(jobs.map(job => job.key));
    for (const cache of [this.manifests, this.runs]) for (const key of cache.keys()) if (!keys.has(key)) cache.delete(key);
    return jobs;
  }

  async collect(lease, job) {
    const { key, competition, season, dataset } = job;
    let phase = 'read';
    try {
      if (!this.manifests.has(key)) {
        this.manifests.set(key, await this.store.readFantasyManifest(competition, season, dataset));
        return { state: 'hydrated', kind: 'fantasy', dataset, competition, season };
      }
      let run = this.runs.get(key);
      const clubsIdentity = JSON.stringify(job.clubs?.map(club => club.id) ?? []);
      if (!run || this.now() - run.startedAt >= 30 * 60000 || run.clubsIdentity !== clubsIdentity) {
        run = { startedAt: this.now(), observedAt: Infinity, pages: [], identities: new Set(), bytes: 0,
          clubsIdentity, index: 0, total: null, fixtures: false, requestCount: 0 };
        this.runs.set(key, run);
      }
      const league = COMPETITIONS[competition].apiFootballLeagueId;
      const path = dataset === 'squads' ? `/players/squads?team=${job.clubs[run.index].id}`
        : run.fixtures ? `/fixtures?league=${league}&season=${season}`
          : `/players?league=${league}&season=${season}&page=${run.index + 1}`;
      phase = 'request';
      const result = await this.provider.request(lease, path, { priority: 'supplementary' });
      if (!result.allowed) return { state: 'deferred', kind: 'fantasy', dataset, competition, season,
        reason: result.reason, retryAt: result.retryAt };
      const { payload, observedAt } = result;
      run.observedAt = Math.min(run.observedAt, observedAt); run.requestCount++;
      phase = 'validation';
      let data;
      if (dataset === 'squads') {
        squadPlayers([payload], [job.clubs[run.index]]);
        run.pages.push(payload); run.index++;
        if (run.index === job.clubs.length) data = { players: squadPlayers(run.pages, job.clubs), complete: true,
          clubIds: job.clubs.map(club => club.id), requestCount: run.requestCount };
      } else if (!run.fixtures) {
        validateHistoryPage(payload, league, season, run.index + 1, run.total, run.identities);
        run.total ??= payload.paging.total; run.pages.push(payload); run.index++;
        run.fixtures = run.index === run.total;
      } else {
        const rates = historyCleanSheetRates(payload, league, season);
        if (!rates.size) throw Error('Historical fixture coverage unavailable');
        data = { stats: [...buildPriorSeasonStatsIndex(run.pages, league)],
          clubs: [...buildPlayerClubAppearances(run.pages, league)].map(([id, clubs]) => [id, [...clubs]]),
          cleanSheets: [...rates], requestCount: run.requestCount };
      }
      run.bytes += Buffer.byteLength(JSON.stringify(payload));
      if (run.bytes > 8 * 1024 * 1024) throw Error('Fantasy collection exceeds memory bound');
      if (!data) return { state: 'collecting', kind: 'fantasy', dataset, competition, season, requests: run.requestCount };
      phase = 'publication';
      const manifest = await this.store.publishFantasy(lease, { competition, season, kind: dataset,
        baseVersion: this.manifests.get(key)?.version ?? 0, observedAt: run.observedAt, data });
      this.manifests.set(key, manifest); this.runs.delete(key);
      return { state: 'published', kind: 'fantasy', dataset, competition, season, version: manifest.version };
    } catch (error) {
      this.runs.delete(key);
      if (phase === 'publication') this.manifests.delete(key);
      return { state: 'failed', kind: 'fantasy', dataset, competition, season, phase, error: error.name,
        retryAt: this.now() + RETRY };
    }
  }
}
