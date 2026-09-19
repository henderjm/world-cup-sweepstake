import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpstreamPacer } from '../src/apiPacer.js';

test('a burst is spaced and excess reads are rejected within the queue budget', async () => {
  let now = 0;
  const starts = [];
  const pace = createUpstreamPacer({ now: () => now, sleep: async ms => { now += ms; } });
  const requests = Array.from({ length: 30 }, () => pace().then(() => starts.push(now)));
  const results = await Promise.allSettled(requests);
  assert.deepEqual(starts, [0, 200, 400, 600, 800, 1000]);
  assert.equal(results.filter(r => r.status === 'rejected').length, 24);
  assert.equal(now, 1000);
  now = 1200;
  assert.equal(await pace(), 0, 'A rejected burst poisoned later attempts');
});

test('late timer wakeup rejects the request instead of sending a burst after suspension', async () => {
  let now = 0;
  const pace = createUpstreamPacer({ now: () => now, sleep: async ms => { now += ms + 1500; } });
  await pace();
  await assert.rejects(pace(), /queue deadline/);
  assert.equal(await pace(), 0, 'A late timer reserved a provider slot');
});

test('a failed timer cannot wedge the queue', async () => {
  let now = 0;
  const pace = createUpstreamPacer({ now: () => now, sleep: async () => { throw Error('timer failed'); } });
  await pace();
  await assert.rejects(pace(), /timer failed/);
  now = 200;
  await pace();
});
