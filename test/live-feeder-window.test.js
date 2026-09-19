import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fixtureDates, shouldRearm } from '../scripts/live-feeder-window.mjs';

test('daytime rearming is independent of live status; late rearming requires follow-up', () => {
  for (const time of ['11:00', '15:00', '21:59']) {
    assert.equal(shouldRearm(Date.parse(`2026-09-19T${time}:00Z`), false), true);
  }
  for (const time of ['22:00', '23:59', '00:00', '02:59']) {
    const now = Date.parse(`2026-09-19T${time}:00Z`);
    assert.equal(shouldRearm(now, true), true);
    assert.equal(shouldRearm(now, false), false);
  }
  for (const time of ['03:00', '05:00', '10:59']) {
    assert.equal(shouldRearm(Date.parse(`2026-09-19T${time}:00Z`), true), false);
  }
});

test('the workflow command uses the same late-match policy', () => {
  for (const [time, following, expected] of [['22:15', 'true', 0], ['22:15', 'false', 1], ['03:00', 'true', 1]]) {
    const bootstrap = 'data:text/javascript,' + encodeURIComponent(`Date.now = () => Date.parse('2026-09-19T${time}:00Z');`);
    const result = spawnSync(process.execPath, ['--import', bootstrap, 'scripts/live-feeder-window.mjs'], {
      env: { ...process.env, FEEDER_FOLLOW_UP: following }, encoding: 'utf8',
    });
    assert.equal(result.status, expected, result.stderr);
  }
});

test('midnight jobs include the previous fixture date until the overnight limit', () => {
  assert.deepEqual(fixtureDates(Date.parse('2026-09-19T23:59:59Z')), ['2026-09-19']);
  assert.deepEqual(fixtureDates(Date.parse('2026-09-20T00:00:00Z')), ['2026-09-19', '2026-09-20']);
  assert.deepEqual(fixtureDates(Date.parse('2026-09-20T02:59:59Z')), ['2026-09-19', '2026-09-20']);
  assert.deepEqual(fixtureDates(Date.parse('2026-09-20T03:00:00Z')), ['2026-09-20']);
  assert.deepEqual(fixtureDates(Date.parse('2027-01-01T00:01:00Z')), ['2026-12-31', '2027-01-01']);
});
