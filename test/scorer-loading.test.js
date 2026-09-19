import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModel, modelSignature } from '../src/data.js';
import { renderStats } from '../src/views.js';

const feed = () => ({
  competition: 'CL', lastUpdated: new Date().toISOString(),
  matches: [{ id: 990001, status: 'IN_PLAY', stage: 'LEAGUE_STAGE', utcDate: new Date().toISOString(), homeTeam: 'Home', awayTeam: 'Away', score: { home: 2, away: 0 } }], standings: [],
});
const scorer = { player: 'Example Player', team: 'Home', goals: 2, assists: 1, points: 3 };

for (const phase of ['headers', 'body']) {
  test(`stalled scorer ${phase} cannot hold healthy scores for eight seconds`, async t => {
    const keepAlive = setInterval(() => {}, 1000);
    t.after(() => clearInterval(keepAlive));
    t.mock.method(globalThis, 'fetch', async (url, { signal }) => {
      if (!url.includes('scorers.json')) return Response.json(feed());
      if (phase === 'headers') return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{"scorers":'));
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      } }));
    });
    const started = performance.now();
    const model = await loadModel('CL');
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 1400 && elapsed < 2500, `Unexpected wait: ${elapsed}ms`);
    assert.equal(model.matches[0].score.home, 2);
    assert.equal(model.stale, false);
    assert.equal(model.scorersUnavailable, true);
    assert.match(renderStats(model), /temporarily unavailable[\s\S]*Retry/);
    assert.doesNotMatch(renderStats(model), /No goals yet/);
  });
}

for (const payload of [null, {}, { scorers: [null] }, { scorers: [{ ...scorer, goals: null }] }]) {
  test(`malformed scorer data does not break healthy scores: ${JSON.stringify(payload)}`, async t => {
    t.mock.method(globalThis, 'fetch', async url => Response.json(url.includes('scorers.json') ? payload : feed()));
    const model = await loadModel('CL');
    assert.equal(model.matches[0].score.home, 2);
    assert.equal(model.scorersUnavailable, true);
  });
}

test('failed, unpublished and recovered statistics have distinct states', async t => {
  let response = () => new Response('Unavailable', { status: 503 });
  t.mock.method(globalThis, 'fetch', async url => url.includes('scorers.json') ? response() : Response.json(feed()));
  const failed = await loadModel('CL');
  response = () => Response.json({ scorers: [] });
  const empty = await loadModel('CL');
  assert.equal(empty.scorersUnavailable, false);
  assert.match(renderStats(empty), /not published yet/);
  assert.notEqual(modelSignature(failed), modelSignature(empty));
  response = () => Response.json({ scorers: [scorer] });
  const recovered = await loadModel('CL');
  assert.equal(recovered.scorersUnavailable, false);
  assert.match(renderStats(recovered), /Example Player/);
  assert.doesNotMatch(renderStats(recovered), /temporarily unavailable/);
});
