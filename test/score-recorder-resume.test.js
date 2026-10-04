import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
const run = promisify(execFile);
const wrapper = new URL('../scripts/resume-score-recorder.py', import.meta.url).pathname;
const recorder = new URL('../scripts/measure-score-reliability.mjs', import.meta.url).pathname;
async function setup(t, future = false) {
  const dir = await mkdtemp(join(tmpdir(), 'recorder-resume-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const start = Date.now() + (future ? 30000 : -30000);
  const plan = { start: new Date(start).toISOString(), end: new Date(start + 20000).toISOString(),
    intervalMs: 1000, origin: 'http://127.0.0.1:1', competitions: ['PL'], fixtures: [] };
  const path = join(dir, 'plan.json'), ledger = join(dir, 'ledger.jsonl');
  await writeFile(path, JSON.stringify(plan));
  return { plan, path, ledger, env: { ...process.env, NODE_BINARY: process.execPath } };
}
test('resume keeps original evidence, truncates only interrupted tail, and retains missing slots', async t => {
  const { plan, path, ledger, env } = await setup(t);
  const prefix = JSON.stringify({ type: 'plan', schema: 1, writerProtocol: 'posix-lock-v1', plan }) + '\n';
  await writeFile(ledger, prefix + '{"type":"probe","unfinished":');
  const { stdout } = await run('python3', [wrapper, path, ledger], { env });
  assert.equal(await readFile(ledger, 'utf8'), prefix);
  const report = JSON.parse(stdout);
  assert.equal(report.competitions.PL.completedChecks, 0);
  await run('python3', [wrapper, path, ledger], { env });
  assert.equal(await readFile(ledger, 'utf8'), prefix);
});
test('different plans and complete corrupt records fail without rewriting evidence', async t => {
  const { plan, path, ledger, env } = await setup(t);
  for (const bytes of [JSON.stringify({ type: 'plan', schema: 1, plan: { ...plan, competitions: ['CL'] } }) + '\n',
    JSON.stringify({ type: 'plan', schema: 1, writerProtocol: 'posix-lock-v1', plan }) + '\n{bad}\n']) {
    await writeFile(ledger, bytes);
    await assert.rejects(run('python3', [wrapper, path, ledger], { env }));
    assert.equal(await readFile(ledger, 'utf8'), bytes);
  }
  await assert.rejects(run(process.execPath, [recorder, 'resume', path, ledger], { env: { ...env, SCORE_RECORDER_LOCK_FD: '' } }), /requires/);
});
test('OS lock excludes concurrent recorders and releases after terminated processes exit', async t => {
  const { path, ledger, env } = await setup(t, true);
  const child = spawn('python3', [wrapper, path, ledger], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode == null) child.kill('SIGTERM'); });
  const exited = once(child, 'exit');
  for (let i = 0; i < 100; i++) {
    if ((await readFile(ledger).catch(() => Buffer.alloc(0))).length) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await assert.rejects(run('python3', [wrapper, path, ledger], { env }), /Another recorder/);
  child.kill('SIGTERM'); await exited;
  // The persistent sidecar is intentionally reused, without stale-lock deletion.
  const { stdout } = await run('python3', ['-c', 'import fcntl,sys; f=open(sys.argv[1],"a+"); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB); print("released")', ledger + '.recorder.lock']);
  assert.equal(stdout.trim(), 'released');
});

test('a restarted real recorder continues future HTTP slots without duplicating saved probes', async t => {
  const { createServer } = await import('node:http');
  const { path, ledger, env } = await setup(t);
  let calls = 0;
  const server = createServer((req, res) => {
    calls++; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ competition: 'PL', matches: [], lastUpdated: new Date().toISOString() }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const at = Date.now() + 200;
  const plan = { start: new Date(at).toISOString(), end: new Date(at + 4000).toISOString(), intervalMs: 1000,
    origin: `http://127.0.0.1:${server.address().port}`, competitions: ['PL'], fixtures: [] };
  await writeFile(path, JSON.stringify(plan));
  const child = spawn('python3', [wrapper, path, ledger], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode == null) child.kill('SIGTERM'); });
  const exited = once(child, 'exit');
  let before = '';
  for (let i = 0; i < 150; i++) {
    before = await readFile(ledger, 'utf8').catch(() => '');
    if (before.includes('"type":"probe"')) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(before.includes('"type":"probe"'));
  child.kill('SIGTERM'); await exited;
  await run('python3', [wrapper, path, ledger], { env });
  const after = await readFile(ledger, 'utf8');
  assert.ok(after.startsWith(before));
  const rows = after.trim().split('\n').map(JSON.parse).slice(1);
  assert.equal(rows.length, 4); assert.equal(calls, 4);
  assert.equal(new Set(rows.map(r => `${r.competition}:${r.scheduledAt}`)).size, 4);
});
