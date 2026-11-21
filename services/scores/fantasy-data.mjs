import { assertApiFootballPayload } from '../../src/apiFootballPayload.js';
import { bucketPosition } from '../../src/fantasy.js';
import { normalizeTeamName } from '../../src/domain.js';
import { decodeEntities, mapApiFootballMatches } from '../../src/mapApiFootball.js';
import { buildPlayerClubAppearances, buildPriorSeasonStatsIndex, previousSeasonsFor } from '../../src/fantasyPlayerTier.js';
import { clubCleanSheetRates } from '../../src/fantasyExpectedPoints.js';

const positive = value => Number.isSafeInteger(value) && value > 0;
const named = value => typeof value === 'string' && value.trim().length > 0;

function page(payload, current, total) {
  assertApiFootballPayload(payload);
  if (payload.paging?.current !== current || !positive(payload.paging.total) || payload.paging.total > 100
    || payload.paging.total < current || (total != null && payload.paging.total !== total)
    || payload.results !== payload.response.length || !payload.response.length)
    throw Error('Incomplete or inconsistent fantasy data page');
}

export function squadPlayers(payloads, clubs, excludedIds) {
  if (!clubs.length || payloads.length !== clubs.length || new Set(clubs.map(club => club.id)).size !== clubs.length)
    throw Error('Incomplete squad collection');
  const players = [], ids = new Set();
  for (const [index, payload] of payloads.entries()) {
    page(payload, 1, 1);
    const squad = payload.response[0], club = clubs[index];
    if (payload.response.length !== 1 || squad.team?.id !== club.id || !positive(club.id)
      || !named(squad.team.name) || !Array.isArray(squad.players) || squad.players.length < 11 || squad.players.length > 100)
      throw Error('Squad does not cover the requested club');
    for (const member of squad.players) {
      if (!positive(member.id) || !named(member.name)
        || !['Goalkeeper', 'Defender', 'Defence', 'Midfielder', 'Midfield', 'Attacker', 'Offence'].includes(member.position))
        throw Error('Invalid or ambiguous squad player');
      if (ids.has(member.id)) {
        if (!excludedIds) throw Error('Invalid or ambiguous squad player');
        excludedIds.add(member.id);
      }
      ids.add(member.id);
      players.push({ id: member.id, name: decodeEntities(member.name), team: normalizeTeamName(squad.team.name),
        position: bucketPosition(member.position), crest: squad.team.logo ?? club.logo ?? null });
    }
  }
  // Conflicting identities cannot safely be assigned a club or fantasy position.
  return excludedIds ? players.filter(player => !excludedIds.has(player.id)) : players;
}

export function validateHistoryPage(payload, leagueId, season, current, total, identities) {
  page(payload, current, total);
  for (const row of payload.response) {
    if (!positive(row.player?.id) || !Array.isArray(row.statistics)) throw Error('Invalid historical player');
    const stats = row.statistics.filter(stat => stat.league?.id === leagueId);
    if (!stats.length) throw Error('Missing requested league statistics');
    for (const stat of stats) {
      const identity = `${row.player.id}:${stat.team?.id}`;
      if (String(stat.league.season) !== String(season) || !positive(stat.team?.id) || identities.has(identity))
        throw Error('Wrong season or repeated player club statistics');
      identities.add(identity);
    }
  }
}

export function historyCleanSheetRates(payload, leagueId, season) {
  page(payload, 1, 1);
  const ids = new Set();
  for (const row of payload.response) {
    if (!positive(row.fixture?.id) || ids.has(row.fixture.id) || row.league?.id !== leagueId
      || String(row.league.season) !== String(season)) throw Error('Wrong season, league or duplicate historical fixture');
    ids.add(row.fixture.id);
  }
  return clubCleanSheetRates(mapApiFootballMatches(payload));
}

export async function fetchFantasyHistory({ leagueId, season, request, log = console.warn, unexpected = () => false }) {
  if (!positive(leagueId) || !/^\d{4}$/.test(String(season))) throw Error('Invalid fantasy history identity');
  const seasons = previousSeasonsFor(season, 3), perSeason = [];
  let requestCount = 0;
  const read = async path => { requestCount++; return request(path); };
  for (const year of seasons) {
    let statsIndex = null, clubAppearances = null, cleanSheetRates = new Map();
    try {
      const pages = [], identities = new Set();
      let total;
      for (let current = 1; current <= (total ?? 1); current++) {
        const payload = await read(`/players?league=${leagueId}&season=${year}&page=${current}`);
        validateHistoryPage(payload, leagueId, year, current, total, identities);
        total ??= payload.paging.total;
        pages.push(payload);
      }
      statsIndex = buildPriorSeasonStatsIndex(pages, leagueId);
      clubAppearances = buildPlayerClubAppearances(pages, leagueId);
    } catch (error) {
      if (unexpected(error)) throw error;
      log(`${year} player statistics unavailable (${error.message}); that season contributes no player history.`);
    }
    try {
      const payload = await read(`/fixtures?league=${leagueId}&season=${year}`);
      cleanSheetRates = historyCleanSheetRates(payload, leagueId, year);
    } catch (error) {
      if (unexpected(error)) throw error;
      log(`${year} fixtures unavailable (${error.message}); no observed clean-sheet rates available.`);
    }
    perSeason.push({ season: year, statsIndex, clubAppearances, cleanSheetRates });
  }
  return { seasons, perSeason, requestCount };
}
