import test from 'node:test';
import assert from 'node:assert/strict';

for (const phase of ['headers', 'body']) {
  test(`slow standings ${phase} are aborted without losing fresh scores or saved table age`, async t => {
    const { default: worker } = await import(`../worker/worker.js?standings-timeout=${phase}`);
    let now = Date.parse('2026-09-19T15:00:00Z'), score = 1, stall = false;
    let tableCalls = 0, pending = 0, aborted = 0, scoreReceivedAt;
    t.mock.method(Date, 'now', () => now);
    const keepAlive = setInterval(() => {}, 1000);
    t.after(() => clearInterval(keepAlive));
    t.mock.method(globalThis, 'fetch', async (url, { signal }) => {
      if (new URL(url).pathname === '/standings') {
        tableCalls++;
        if (stall) {
          pending++;
          const wait = () => new Promise((_, reject) => signal.addEventListener('abort', () => {
            pending--; aborted++; reject(signal.reason);
          }, { once: true }));
          if (phase === 'headers') return wait();
          return { ok: true, status: 200, headers: new Headers(), json: wait };
        }
        return Response.json({ errors: [], response: [{ league: { standings: [[{
          rank: 1, team: { id: 1, name: 'Home' }, points: score === 1 ? 3 : 6,
          all: { played: 1, win: 1, goals: { for: 1, against: 0 } },
        }]] } }] });
      }
      scoreReceivedAt = performance.now();
      return Response.json({ errors: [], response: [{
        fixture: { id: 900001, date: '2026-09-19T14:30:00Z', status: { short: '1H', elapsed: 30 } },
        league: { id: 2, season: 2026, round: 'League Stage - 1' },
        teams: { home: { id: 1, name: 'Home' }, away: { id: 2, name: 'Away' } },
        goals: { home: score, away: 0 }, score: { fulltime: { home: null, away: null } },
      }] });
    });
    const env = { API_FOOTBALL_KEY: 'fixture', API_FOOTBALL_COMPETITIONS: 'CL:2026' };
    const read = async (target = worker) => {
      const response = await target.fetch(new Request('https://test.invalid/CL/live'), env, { waitUntil() {} });
      assert.equal(response.status, 200);
      return response.json();
    };
    const initial = await read();
    now += 361000; stall = true; score = 2;
    const delayed = await Promise.all([read(), read()]);
    const extraWait = performance.now() - scoreReceivedAt;
    assert.ok(extraWait >= 1400 && extraWait < 2100, `Standings held scores for ${extraWait}ms`);
    assert.equal(pending, 0, 'Timed-out origin read remained running');
    assert.equal(aborted, 1, 'Concurrent callers should share one cancelled origin request');
    assert.equal(tableCalls, 2);
    for (const data of delayed) {
      assert.equal(data.matches[0].score.home, 2);
      assert.equal(data.lastUpdated, new Date(now).toISOString());
      assert.ok(!data.stale);
      assert.equal(data.standingsDelayed, true);
      assert.equal(data.standingsUpdatedAt, initial.standingsUpdatedAt);
    }
    const { default: cold } = await import(`../worker/worker.js?cold-standings-timeout=${phase}`);
    const coldData = await read(cold);
    assert.equal(coldData.matches[0].score.home, 2);
    assert.deepEqual(coldData.standings, []);
    assert.equal(pending, 0);
    stall = false; now += 61000;
    const recovered = await read();
    assert.equal(recovered.standingsDelayed, false);
    assert.equal(recovered.standings[0].table[0].points, 6);
    assert.equal(recovered.standingsUpdatedAt, new Date(now).toISOString());
  });
}
