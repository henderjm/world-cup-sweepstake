import { readFile, writeFile, rename, rm, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { storedOrigin, fetchStoredJson } from '../../worker/stored-read.js';
import { previousSeasonsFor } from '../../src/fantasyPlayerTier.js';

export async function exportStoredPlayerPool({ origin, competition, season, path, fetcher = fetch, now = Date.now }) {
  if (competition !== 'PL' || !/^\d{4}$/.test(String(season))) throw Error('Unsupported stored player pool');
  const { body } = await fetchStoredJson(`${storedOrigin(origin)}/PL/players`, { fetcher, timeoutMs: 4000, maxBytes: 4 * 1024 * 1024 });
  const meta = body.coverage?.squads;
  const validMeta = value => value && Number.isSafeInteger(value.version) && value.version > 0
    && Number.isSafeInteger(value.collectorEpoch) && value.collectorEpoch > 0
    && Number.isSafeInteger(value.observedAt) && value.observedAt > 0 && value.observedAt <= now();
  if (body.source !== 'stored-score-service' || body.competition !== competition || body.season !== String(season)
    || body.complete !== true || body.stale !== false || !validMeta(meta) || meta.state !== 'complete'
    || now() - meta.observedAt > 2 * 86400000 || Date.parse(body.lastUpdated) !== meta.observedAt
    || !Array.isArray(body.players) || !body.players.length || body.players.length > 4000
    || body.players.some(player => !Number.isSafeInteger(player.id) || player.id < 1 || typeof player.name !== 'string'
      || !player.name.trim() || typeof player.team !== 'string' || !player.team.trim() || !['GK', 'DEF', 'MID', 'FWD'].includes(player.position))
    || new Set(body.players.map(player => player.id)).size !== body.players.length
    || !Array.isArray(body.degraded) || !body.xpStats || !body.priorSeasonStats) throw Error('Invalid or stale stored player pool');
  for (const year of previousSeasonsFor(season, 3)) {
    const entry = body.coverage.history?.[year];
    if (!entry || !['complete', 'missing', 'unavailable', 'stale', 'invalid'].includes(entry.state)
      || (entry.state === 'complete' && (!validMeta(entry) || now() - entry.observedAt > 14 * 86400000))
      || body.degraded.includes(year) !== (entry.state !== 'complete')) throw Error('Invalid stored history coverage');
  }
  let old;
  try { old = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (old && (old.season == null || String(old.season) === String(season))) {
    if (Date.parse(old.lastUpdated) > meta.observedAt || body.degraded.length) throw Error('Export would regress player pool coverage or age');
    if (old.source === 'stored-score-service') {
      const pairs = [[old.coverage?.squads, meta], ...previousSeasonsFor(season, 3).map(year => [old.coverage?.history?.[year], body.coverage.history[year]])];
      if (pairs.some(([before, after]) => before && ['version', 'collectorEpoch', 'observedAt'].some(key => (before[key] ?? 0) > (after[key] ?? 0))))
        throw Error('Export would regress player pool version');
    }
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try { await writeFile(temporary, JSON.stringify(body) + '\n', { flag: 'wx' }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
  return { players: body.players.length, degraded: body.degraded, lastUpdated: body.lastUpdated };
}
