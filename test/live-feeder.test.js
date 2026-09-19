import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function run(t, scenario, budget) {
  const dir = mkdtempSync(join(tmpdir(), 'feeder-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = join(dir, 'result.json'), output = join(dir, 'output');
  const env = { ...process.env, API_FOOTBALL_KEY: 'fixture', DETAIL_INGEST_TOKEN: 'fixture',
    API_FOOTBALL_COMPETITIONS: 'PL:2026', WORKER_ORIGIN: 'https://fixture.invalid',
    FEEDER_TEST_SCENARIO: scenario, FEEDER_TEST_RESULT: result, GITHUB_OUTPUT: output };
  delete env.FEEDER_LOOP_BUDGET_MS; delete env.FEEDER_LOOP_INTERVAL_MS;
  if (budget) env.FEEDER_LOOP_BUDGET_MS = String(budget);
  const child = spawnSync(process.execPath, ['--import', './test/fixtures/feeder-runtime.mjs', 'scripts/feed-live-details.mjs'], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  return { ...JSON.parse(readFileSync(result)), output: readFileSync(output, 'utf8') };
}

test('live coverage fills the old re-arm gap without increasing detail frequency', t => {
  const old = run(t, 'live', 240000), current = run(t, 'live');
  assert.equal(old.discoveries, 4);
  assert.equal(current.discoveries, 6);
  assert.equal(current.output, 'rearm_delay_seconds=60\n');
  const details = result => result.calls.filter(call => call.path.startsWith('/fixtures/') || call.path.startsWith('/ingest/detail/'));
  assert.deepEqual(details(current), details(old), 'Added live passes must not repeat detail fan-out');
  assert.equal(current.pushes.at(-1).at + 60000, old.pushes.at(-1).at + 180000, 'Detail run cadence changed');
  for (let i = 1; i < current.pushes.length; i++) {
    assert.ok(current.pushes[i].at - current.pushes[i - 1].at <= 62000);
  }
});

for (const scenario of ['transient', 'first-failure', 'empty', 'malformed', 'failed-ingest']) {
  test(`${scenario} discovery/ingest does not stop live rechecks`, t => {
    const result = run(t, scenario);
    assert.equal(result.discoveries, 6);
    assert.equal(result.output, 'rearm_delay_seconds=60\n');
    assert.ok(result.elapsed < 360000, 'Run exceeded its bounded loop');
    if (['transient', 'first-failure', 'empty'].includes(scenario)) assert.equal(result.pushes.length, 5);
    if (scenario === 'first-failure') assert.equal(result.calls.filter(call => call.path.startsWith('/ingest/detail/')).length, 1);
    if (scenario === 'malformed' || scenario === 'failed-ingest') assert.equal(result.pushes.length, 0);
  });
}

test('genuinely idle and newly finished matchdays return to the slower cadence', t => {
  const idle = run(t, 'idle'), finished = run(t, 'finished');
  assert.equal(idle.discoveries, 1);
  assert.equal(finished.discoveries, 3);
  assert.equal(idle.output, 'rearm_delay_seconds=180\n');
  assert.equal(finished.output, 'rearm_delay_seconds=180\n');
});
