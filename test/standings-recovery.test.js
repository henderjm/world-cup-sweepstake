import test from 'node:test';
import assert from 'node:assert/strict';
import { createStandingsRecovery } from '../src/standingsRecovery.js';
import { buildModel, modelSignature } from '../src/data.js';
import { renderMiniTable, renderTable, renderHero } from '../src/views.js';
const now = Date.parse('2026-09-19T12:00:00Z');
const full = { competition: 'PL', season: 2026, lastUpdated: '2026-09-19T11:00:00Z', matches: [{ id: 1, status: 'FINISHED', utcDate: '2026-09-19T10:00:00Z', homeTeam: 'Home', awayTeam: 'Away', score: { home: 1, away: 0 } }], standings: [{ type: 'TOTAL', table: [{ position: 1, team: { name: 'Home' }, playedGames: 1, points: 3 }] }] };
const partial = () => ({ ...full, lastUpdated: '2026-09-19T12:00:00Z', matches: [{ ...full.matches[0], score: { home: 2, away: 0 }, status: 'IN_PLAY' }], standings: [] });
test('server-recovered tables keep their own age through a later empty response and reload', async t => {
  setup(t);
  const recover = createStandingsRecovery(() => { throw Error('offline'); });
  const raw = { ...partial(), standings: full.standings, standingsDelayed: true, standingsUpdatedAt: full.lastUpdated };
  const model = buildModel(await recover(raw, 'PL'));
  assert.equal(model.stale, false);
  assert.equal(model.tablesLive, false);
  assert.match(renderMiniTable(model), /Showing the saved table/);
  const reloaded = await createStandingsRecovery(() => { throw Error('offline'); })(partial(), 'PL');
  assert.equal(reloaded.standingsUpdatedAt, full.lastUpdated);
});
test('an expired server-recovered table cannot be refreshed by the score timestamp', async t => {
  setup(t);
  const raw = { ...partial(), standings: full.standings, standingsDelayed: true, standingsUpdatedAt: '2026-09-01T00:00:00Z' };
  const recovered = await createStandingsRecovery(() => { throw Error('offline'); })(raw, 'PL');
  assert.equal(recovered.standings.length, 0);
  assert.equal(recovered.standingsUnavailable, true);
  assert.equal(recovered.matches[0].score.home, 2);
});
function setup(t) {
  t.mock.method(Date, 'now', () => now);
  const values = new Map();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage; });
  return values;
}
test('saved standings recover independently without rolling scores or timestamps back', async t => {
  setup(t); let reads = 0;
  const recover = createStandingsRecovery(async () => { reads++; return full; });
  const raw = partial();
  const recovered = await recover(raw, 'PL');
  assert.equal(recovered.matches, raw.matches);
  assert.equal(recovered.lastUpdated, raw.lastUpdated);
  assert.equal(recovered.standings, full.standings);
  assert.equal(recovered.standingsUpdatedAt, full.lastUpdated);
  assert.equal(recovered.standingsDelayed, true);
  assert.equal(raw.standings.length, 0);
  await recover(partial(), 'PL');
  assert.equal(reads, 1);
  const reloaded = await createStandingsRecovery(() => { throw Error('offline'); })(partial(), 'PL');
  assert.equal(reloaded.standingsUpdatedAt, full.lastUpdated);
});
test('complete live tables supersede saved ones and clear table-only delay', async t => {
  setup(t); const recover = createStandingsRecovery(async () => full);
  await recover(partial(), 'PL');
  const live = { ...full, lastUpdated: partial().lastUpdated };
  assert.equal(await recover(live, 'PL'), live);
});
for (const change of [{ season: 2025 }, { competition: 'CL' }, { lastUpdated: '2026-09-01T00:00:00Z' }, { lastUpdated: '2027-01-01T00:00:00Z' }]) {
  test(`unsafe fallback is rejected: ${JSON.stringify(change)}`, async t => {
    setup(t); const raw = partial();
    const result = await createStandingsRecovery(async () => ({ ...full, ...change }))(raw, 'PL');
    assert.equal(result.standingsUnavailable, true);
    assert.equal(result.matches, raw.matches);
    assert.equal(result.standings.length, 0);
  });
}
test('blocked storage retains tables for the visit', async t => {
  setup(t); globalThis.localStorage.setItem = () => { throw Error('blocked'); };
  const recover = createStandingsRecovery(() => { throw Error('offline'); });
  await recover(full, 'PL');
  assert.equal((await recover(partial(), 'PL')).standingsDelayed, true);
});
test('unstarted and qualifying-only competitions do not imply missing league tables or fetch a fallback', async t => {
  setup(t); let calls = 0;
  const recover = createStandingsRecovery(() => { calls++; throw Error('unexpected'); });
  const pre = await recover({ ...partial(), matches: [{ status: 'TIMED' }] }, 'PL');
  const cl = await recover({ ...partial(), competition: 'CL', matches: [{ status: 'FINISHED', stage: 'FIRST_QUALIFYING_ROUND' }] }, 'CL');
  assert.equal(calls, 0); assert.equal(pre.standingsUnavailable, false); assert.equal(cl.standingsUnavailable, false);
});
test('saved table age is visible in both views, fresh scores stay fresh, and live projection is disabled', async t => {
  setup(t); const raw = await createStandingsRecovery(async () => full)(partial(), 'PL');
  const model = buildModel(raw);
  assert.equal(model.stale, false); assert.equal(model.tablesLive, false);
  assert.equal(model.tables[0].rows[0].points, 3);
  assert.match(renderHero(model), /Top \(saved\)/);
  for (const html of [renderMiniTable(model), renderTable(model)]) {
    assert.match(html, /Showing the saved table/); assert.match(html, /Retry/);
    assert.doesNotMatch(html, /As it stands|data-feed-age/);
  }
  assert.notEqual(modelSignature(model), modelSignature({ ...model, standingsDelayed: false }));
});
test('unavailable tables offer retry without claiming the table is unpublished', async t => {
  setup(t); const model = buildModel(await createStandingsRecovery(() => { throw Error('offline'); })(partial(), 'PL'));
  for (const html of [renderMiniTable(model), renderTable(model)]) {
    assert.match(html, /Standings temporarily unavailable/); assert.doesNotMatch(html, /published yet/);
  }
});

test('malformed stored and static tables cannot break fresh scores', async t => {
  const values = setup(t);
  for (const standings of [{}, [null], [{ type: 'TOTAL', table: [null] }], [{ type: 'TOTAL', table: [{ team: { name: 'Home' } }] }]]) {
    const malformed = { ...full, standings };
    values.set('gs-standings-PL', JSON.stringify(malformed));
    const result = await createStandingsRecovery(async () => malformed)(partial(), 'PL');
    assert.equal(result.matches[0].score.home, 2);
    assert.equal(result.standingsUnavailable, true);
  }
});
