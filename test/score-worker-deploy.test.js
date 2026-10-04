import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { workerDeployArgs } from '../scripts/deploy-score-worker.mjs';

test('Worker deployment uses one explicit source binding and rejects unsafe origins', () => {
  const args = workerDeployArgs('https://reader.execute-api.eu-west-1.amazonaws.com/', true);
  assert.deepEqual(args.slice(-3), ['--var', 'SCORE_READ_ORIGIN:https://reader.execute-api.eu-west-1.amazonaws.com', '--dry-run']);
  assert.equal(workerDeployArgs()[4], 'SCORE_READ_ORIGIN:');
  for (const origin of [' ', 'http://127.0.0.1', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com?q=secret'])
    assert.throws(() => workerDeployArgs(origin));
});

test('CLI defaults to preview and dry-run hands the binding to Wrangler without shell interpolation', t => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-deploy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const capture = join(dir, 'capture.json');
  writeFileSync(join(dir, 'npx'), `#!${process.execPath}\nrequire('fs').writeFileSync(process.env.CAPTURE, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));\n`, { mode: 0o700 });
  const env = { ...process.env, PATH: dir + ':' + process.env.PATH, CAPTURE: capture, SCORE_READ_ORIGIN: 'https://reader.example.com' };
  const run = args => spawnSync(process.execPath, ['scripts/deploy-score-worker.mjs', ...args], { env, encoding: 'utf8' });
  const preview = run([]); assert.equal(preview.status, 0, preview.stderr); assert.equal(JSON.parse(preview.stdout).mode, 'preview');
  assert.throws(() => readFileSync(capture));
  const dryRun = run(['--dry-run']); assert.equal(dryRun.status, 0, dryRun.stderr);
  const called = JSON.parse(readFileSync(capture));
  assert.deepEqual(called.args, workerDeployArgs(env.SCORE_READ_ORIGIN, true));
  assert.ok(called.cwd.endsWith('/worker'));
  assert.notEqual(run(['--unknown']).status, 0);
});

test('Worker CI shares the source variable used by exports and feeder gating', () => {
  const workflow = readFileSync('.github/workflows/deploy-worker.yml', 'utf8');
  assert.match(workflow, /node \.\.\/scripts\/deploy-score-worker\.mjs --deploy/);
  assert.match(workflow, /SCORE_READ_ORIGIN: \$\{\{ vars\.SCORE_READ_ORIGIN \}\}/);
});
