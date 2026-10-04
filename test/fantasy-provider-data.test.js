import test from 'node:test';
import assert from 'node:assert/strict';
import { squadPlayers, fetchFantasyHistory } from '../services/scores/fantasy-data.mjs';
import { deriveTiersFromSeason, enrichPoolWithHistoricalXp } from '../src/fantasyHistoricalXp.js';

const envelope = (response, current = 1, total = 1) => ({ errors: [], results: response.length, response, paging: { current, total } });
const club = { id: 42, name: 'Arsenal' };
const squad = () => envelope([{ team: club, players: Array.from({ length: 11 }, (_, i) =>
  ({ id: i + 1, name: `Player ${i + 1}`, position: i === 0 ? 'Goalkeeper' : 'Defence' })) }]);
const stat = (year, team = 42, id = 1) => ({ player: { id, name: 'Player' }, statistics: [{ team: { id: team, name: team === 42 ? 'Arsenal' : 'Chelsea' },
  league: { id: 39, season: Number(year) }, games: { appearences: 10, lineups: 10, minutes: 900 }, goals: { total: 3, assists: 1 }, cards: {} }] });
const fixture = year => ({ fixture: { id: 77, date: `${year}-09-01T12:00:00Z`, status: { short: 'FT' } },
  league: { id: 39, season: Number(year) }, teams: { home: club, away: { id: 49, name: 'Chelsea' } }, goals: { home: 1, away: 0 } });
async function history(alter = body => body) {
  const calls = [];
  const result = await fetchFantasyHistory({ leagueId: 39, season: '2026', log() {}, request: async path => {
    calls.push(path);
    const url = new URL(path, 'https://synthetic.invalid'), year = url.searchParams.get('season');
    const current = Number(url.searchParams.get('page'));
    const body = url.pathname === '/players' ? envelope([stat(year, current === 1 ? 42 : 49)], current, 2) : envelope([fixture(year)]);
    return alter(body, url);
  } });
  return { ...result, calls };
}

test('complete squads preserve identities and normalized positions', () => {
  const players = squadPlayers([squad()], [club]);
  assert.equal(players.length, 11); assert.equal(players[0].position, 'GK');
  assert.equal(players[1].position, 'DEF'); assert.equal(players[0].team, 'Arsenal');
});

test('empty, partial, wrong-club, duplicate and ambiguous squads cannot be complete', () => {
  for (const modify of [
    p => { p.response[0].players = []; },
    p => { p.response[0].players.pop(); },
    p => { p.response[0].team = { ...club, id: 49 }; },
    p => { p.response[0].players[1].id = 1; },
    p => { p.response[0].players[1].position = 'Unknown'; },
    p => { p.paging.total = 2; },
  ]) { const payload = squad(); modify(payload); assert.throws(() => squadPlayers([payload], [club])); }
  assert.throws(() => squadPlayers([], [club]));
});

test('complete history retains transferred-player contributions and existing tier/xP calculations', async () => {
  const result = await history();
  assert.equal(result.requestCount, 9); assert.equal(result.calls.length, 9);
  assert.deepEqual(result.seasons, ['2025', '2024', '2023']);
  assert.equal(result.perSeason[0].statsIndex.get(1).minutes, 1800);
  assert.equal(result.perSeason[0].clubAppearances.get(1).size, 2);
  const tiers = deriveTiersFromSeason(squadPlayers([squad()], [club]), result.perSeason[0]);
  assert.equal(tiers.players[0].tier, 'starter');
  const enriched = enrichPoolWithHistoricalXp(tiers.players, result.perSeason, result.requestCount);
  assert.equal(enriched.players[0].xpBasis, 'history'); assert.ok(enriched.players[0].xp > 0);
});

test('repeated or missing pages, changing totals and wrong seasons discard the whole affected history', async () => {
  for (const change of [
    p => { p.paging.current = 1; },
    p => { p.paging.total = 3; },
    p => { p.response = []; p.results = 0; },
    p => { p.response[0] = stat('2025', 42); },
    p => { p.response[0].statistics[0].league.season = 2024; },
  ]) {
    const result = await history((body, url) => {
      if (url.pathname === '/players' && url.searchParams.get('season') === '2025' && url.searchParams.get('page') === '2') change(body);
      return body;
    });
    assert.equal(result.perSeason[0].statsIndex, null);
    assert.equal(result.perSeason[0].clubAppearances, null);
    assert.equal(result.perSeason[1].statsIndex.get(1).minutes, 1800);
  }
});

test('unbounded or malformed pagination cannot trigger a large request fan-out', async () => {
  for (const total of [0, -1, 101, 1.5, '2']) {
    const result = await history((body, url) => { if (url.pathname === '/players') body.paging.total = total; return body; });
    assert.equal(result.calls.length, 6);
    assert.ok(result.perSeason.every(season => season.statsIndex === null));
  }
});

test('historical fixture identity and pagination failures cannot supply clean-sheet rates', async () => {
  for (const change of [
    p => { p.response[0].league.season = 2020; },
    p => { p.response[0].league.id = 2; },
    p => { p.paging.total = 2; },
    p => { p.response.push(p.response[0]); p.results++; },
  ]) {
    const result = await history((body, url) => { if (url.pathname === '/fixtures') change(body); return body; });
    assert.ok(result.perSeason.every(season => season.cleanSheetRates.size === 0));
    assert.ok(result.perSeason.every(season => season.statsIndex.get(1).minutes === 1800));
  }
});

test('failed attempts are counted and a later season can still contribute', async () => {
  const result = await history((body, url) => {
    if (url.searchParams.get('season') === '2025') throw Error('temporary outage');
    return body;
  });
  assert.equal(result.requestCount, result.calls.length); assert.equal(result.requestCount, 8);
  assert.equal(result.perSeason[0].statsIndex, null); assert.ok(result.perSeason[1].statsIndex);
});

test('unexpected execution failures propagate instead of silently degrading', async () => {
  const failure = Object.assign(Error('CLI crash'), { code: 2 });
  await assert.rejects(fetchFantasyHistory({ leagueId: 39, season: '2026', request: async () => { throw failure; },
    unexpected: error => error.code === 2 }), error => error === failure);
});
