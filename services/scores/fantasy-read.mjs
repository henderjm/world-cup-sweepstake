import { previousSeasonsFor, sortPlayerPool } from '../../src/fantasyPlayerTier.js';
import { deriveTiersFromSeason, enrichPoolWithHistoricalXp } from '../../src/fantasyHistoricalXp.js';

const DAY = 86400000;
const positive = value => Number.isSafeInteger(value) && value > 0;
const named = value => typeof value === 'string' && value.trim().length > 0;
const number = value => Number.isFinite(value) && value >= 0;

function observation(record, season, kind, now, maxAge) {
  if (!record || record.competition !== 'PL' || record.season !== season || record.kind !== kind
    || !positive(record.version) || !positive(record.collectorEpoch) || !positive(record.observedAt)
    || record.observedAt > now) throw Error('Invalid fantasy dataset identity or observation');
  return { version: record.version, collectorEpoch: record.collectorEpoch, observedAt: record.observedAt,
    state: now - record.observedAt > maxAge ? 'stale' : 'complete' };
}
function pairs(rows, validKey, validValue) {
  if (!Array.isArray(rows) || rows.length > 4000 || rows.some(row => !Array.isArray(row) || row.length !== 2
    || !validKey(row[0]) || !validValue(row[1])) || new Set(rows.map(row => row[0])).size !== rows.length)
    throw Error('Invalid fantasy history rows');
  return new Map(rows);
}
const statsKeys = ['appearances', 'lineups', 'minutes', 'goals', 'assists', 'conceded', 'yellow', 'yellowRed', 'red', 'ownGoals'];

export function storedPlayerPool(squads, history, season, now) {
  const coverage = { squads: observation(squads, season, 'squads', now, 2 * DAY), history: {} };
  const players = squads.data?.players;
  if (squads.data?.complete !== true || !Array.isArray(players) || !players.length || players.length > 4000
    || players.some(player => !positive(player.id) || !named(player.name) || !named(player.team)
      || !['GK', 'DEF', 'MID', 'FWD'].includes(player.position)) || new Set(players.map(player => player.id)).size !== players.length)
    throw Error('Invalid stored squad pool');
  let requestCount = 0;
  const perSeason = previousSeasonsFor(season, 3).map(year => {
    const empty = { season: year, statsIndex: null, clubAppearances: null, cleanSheetRates: new Map() };
    const record = history[year];
    coverage.history[year] = { state: record === undefined ? 'unavailable' : 'missing' };
    if (!record) return empty;
    try {
      const meta = observation(record, year, 'history', now, 14 * DAY);
      coverage.history[year] = meta;
      if (meta.state !== 'complete') return empty;
      const statsIndex = pairs(record.data?.stats, positive, row => row && statsKeys.every(key => number(row[key])));
      const clubAppearances = pairs(record.data?.clubs, positive, rows => { pairs(rows, named, number); return true; });
      for (const [id, clubs] of clubAppearances) clubAppearances.set(id, new Map(clubs));
      const cleanSheetRates = pairs(record.data?.cleanSheets, named, rate => number(rate) && rate <= 1);
      if (!statsIndex.size || !cleanSheetRates.size) throw Error('Incomplete stored history');
      if (!Number.isSafeInteger(record.data.requestCount) || record.data.requestCount < 1) throw Error('Invalid collection request count');
      requestCount += record.data.requestCount;
      return { season: year, statsIndex, clubAppearances, cleanSheetRates };
    } catch { coverage.history[year] = { state: 'invalid' }; return empty; }
  });
  const tiers = deriveTiersFromSeason(players, perSeason[0]);
  const xp = enrichPoolWithHistoricalXp(tiers.players, perSeason, requestCount);
  return { source: 'stored-score-service', competition: 'PL', season, complete: true,
    lastUpdated: new Date(squads.observedAt).toISOString(), stale: coverage.squads.state !== 'complete', coverage,
    degraded: Object.entries(coverage.history).filter(([, value]) => value.state !== 'complete').map(([year]) => year),
    priorSeasonStats: tiers.header, xpStats: xp.header, players: sortPlayerPool(xp.players) };
}

export function createFantasyReadApi({ store, seasons, now = Date.now }) {
  const headers = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
  const json = (body, status = 200) => Response.json(body, { status, headers });
  return async request => {
    if (new URL(request.url).pathname !== '/PL/players' || !seasons.PL) return json({ error: 'not found' }, 404);
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    try {
      const season = String(seasons.PL);
      const [squads, ...history] = await Promise.all([
        store.readFantasy('PL', season, 'squads'),
        ...previousSeasonsFor(season, 3).map(year => store.readFantasy('PL', year, 'history').catch(() => undefined)),
      ]);
      if (!squads) return json({ error: 'squads not collected yet' }, 503);
      return json(storedPlayerPool(squads, Object.fromEntries(previousSeasonsFor(season, 3).map((year, i) => [year, history[i]])), season, now()));
    } catch { return json({ error: 'stored player pool unavailable' }, 503); }
  };
}
