import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function run(t, scenario, budget, competitions = 'PL:2026') {
  const dir = mkdtempSync(join(tmpdir(), 'feeder-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = join(dir, 'result.json'), output = join(dir, 'output');
  const env = { ...process.env, API_FOOTBALL_KEY: 'fixture', DETAIL_INGEST_TOKEN: 'fixture',
    API_FOOTBALL_COMPETITIONS: competitions, WORKER_ORIGIN: 'https://fixture.invalid',
    FEEDER_TEST_SCENARIO: scenario, FEEDER_TEST_RESULT: result, GITHUB_OUTPUT: output };
  delete env.FEEDER_LOOP_BUDGET_MS; delete env.FEEDER_LOOP_INTERVAL_MS;
  if (competitions == null) delete env.API_FOOTBALL_COMPETITIONS;
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

test('both competitions receive scores before any detail and every provider call is paced', t => {
  const result = run(t, 'live', undefined, null);
  assert.deepEqual(result.byLeague, { 39: 6, 2: 6 });
  assert.deepEqual(result.calls.slice(0, 4).map(call => call.path), ['/fixtures', '/ingest/live/PL', '/fixtures', '/ingest/live/CL']);
  assert.equal(result.calls.filter(call => call.path.startsWith('/ingest/detail/')).length, 2);
  const reads = result.calls.filter(call => call.provider);
  for (let i = 1; i < reads.length; i++) assert.ok(reads[i].at - reads[i - 1].at >= 400);
  for (const competition of ['PL', 'CL']) {
    const pushes = result.pushes.filter(push => push.competition === competition);
    assert.equal(pushes.length, 6);
    for (let i = 1; i < pushes.length; i++) assert.ok(pushes[i].at - pushes[i - 1].at <= 65000);
  }
});

test('an idle competition is read only once while its neighbour remains live', t => {
  assert.deepEqual(run(t, 'cl-idle', undefined, 'PL:2026,CL:2026').byLeague, { 39: 6, 2: 1 });
  assert.deepEqual(run(t, 'pl-idle', undefined, 'PL:2026,CL:2026').byLeague, { 39: 1, 2: 6 });
  const idle = run(t, 'both-idle', undefined, 'PL:2026,CL:2026');
  assert.deepEqual(idle.byLeague, { 39: 1, 2: 1 });
  assert.equal(idle.output, 'rearm_delay_seconds=180\n');
});

for (const scenario of ['cl-failure', 'cl-empty']) {
  test(`${scenario} recovers without disrupting Premier League pushes`, t => {
    const result = run(t, scenario, undefined, 'PL:2026,CL:2026');
    assert.deepEqual(result.byLeague, { 39: 6, 2: 6 });
    assert.equal(result.pushes.filter(push => push.competition === 'PL').length, 6);
    assert.equal(result.pushes.filter(push => push.competition === 'CL').length, 5);
    assert.equal(result.calls.filter(call => call.path === '/ingest/detail/900002').length, 1);
  });
}

test('a known upcoming Champions League kickoff resumes discovery within the live loop', t => {
  const result = run(t, 'cl-kickoff', undefined, 'PL:2026,CL:2026');
  const reads = result.calls.filter(call => call.query.includes('league=2'));
  assert.equal(reads.length, 6);
  assert.ok(reads[1].at >= 90000 && reads[1].at < 150000);
  assert.equal(result.output, 'rearm_delay_seconds=60\n');
});

for (const scenario of ['low-quota', 'critical-quota', 'quota-retained']) {
  test(`${scenario} preserves live reads and skips optional detail across both competitions`, t => {
    const result = run(t, scenario, undefined, 'PL:2026,CL:2026');
    assert.deepEqual(result.byLeague, { 39: 6, 2: 6 });
    assert.equal(result.calls.filter(call => call.provider).length, 12);
    assert.equal(result.pushes.length, 12);
  });
}

test('a declining quota stops detail fan-out before its next provider request', t => {
  const result = run(t, 'quota-drops-in-detail', undefined, 'PL:2026,CL:2026');
  assert.equal(result.calls.filter(call => call.provider && !call.query.includes('date=')).length, 1);
  assert.equal(result.calls.filter(call => call.path.startsWith('/ingest/detail/')).length, 0);
  assert.equal(result.pushes.length, 12);
});

for (const scenario of ['http-limit', 'payload-limit', 'minute-empty']) {
  test(`${scenario} cools down the shared feeder before calling the next competition`, t => {
    const result = run(t, scenario, undefined, 'PL:2026,CL:2026');
    const reads = result.calls.filter(call => call.provider);
    assert.ok(reads[1].at - reads[0].at >= 60000);
    assert.ok(result.pushes.some(push => push.competition === 'CL'));
  });
}

for (const scenario of ['extra-time', 'extra-break', 'shootout']) {
  test(`Champions League ${scenario} keeps score discovery active`, t => {
    const result = run(t, scenario, undefined, 'CL:2026');
    assert.equal(result.discoveries, 6);
    assert.equal(result.pushes.length, 6);
    assert.equal(result.calls.filter(call => call.path.startsWith('/ingest/detail/')).length, 1);
    assert.equal(result.output, 'rearm_delay_seconds=60\n');
  });
}

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

for (const scenario of ['crowded-slow', 'crowded-stall', 'crowded-headers', 'crowded-ingest']) {
  test(`${scenario}: detail work cannot monopolise score delivery for both leagues`, t => {
    const result = run(t, scenario, undefined, 'PL:2026,CL:2026');
    for (const competition of ['PL', 'CL']) {
      const pushes = result.pushes.filter(push => push.competition === competition);
      assert.ok(pushes.length >= 5, `${competition}: only ${pushes.length} pushes`);
      for (let i = 1; i < pushes.length; i++) {
        assert.ok(pushes[i].at - pushes[i - 1].at <= 71000, `${competition}: score gap exceeded 71 seconds`);
      }
    }
    const details = result.calls.filter(call => call.path.startsWith('/ingest/detail/'));
    if (scenario === 'crowded-slow') assert.ok(details.length >= 8, 'Detail should keep making progress between score polls');
    if (scenario === 'crowded-ingest') assert.ok(details.length >= 7, 'Slow ingestion should not starve detail');
    if (['crowded-stall', 'crowded-headers'].includes(scenario)) {
      assert.ok(result.timeouts >= 19, 'Every failed match must hit its request deadline');
      assert.equal(details.length, 0, 'Incomplete detail must not be ingested');
    }
    assert.equal(new Set(details.map(call => call.path)).size, details.length, 'Detail repeated within the job');
    assert.ok(result.elapsed <= 360000, 'Slow detail exceeded the job budget');
  });
}

test('the real run deadline cancels a stalled detail body', t => {
  const result = run(t, 'real-body-stall', 1000);
  assert.equal(result.timeouts, 1);
  assert.equal(result.calls.filter(call => call.path.startsWith('/ingest/detail/')).length, 0);
  assert.ok(result.elapsed >= 900 && result.elapsed < 2000, `Elapsed ${result.elapsed}ms`);
  assert.equal(result.output, 'rearm_delay_seconds=60\n');
});
