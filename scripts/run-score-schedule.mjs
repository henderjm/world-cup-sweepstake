import { spawn } from 'node:child_process';
import { readFile, open, mkdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { validatePlan } from './lib/scoreReliability.mjs';
import { requireMonitorLock } from './lib/scoreMonitorLock.mjs';
import { alertDestination } from './lib/scoreAlerts.mjs';

export function validateSchedule(input) {
  if (!Array.isArray(input.windows) || !input.windows.length || input.windows.length > 31)
    throw Error('Schedule requires 1 to 31 explicit windows');
  const windows = input.windows.map(validatePlan);
  for (const [i, p] of windows.entries()) {
    if (!(typeof p.fixtureReference === 'string' && p.fixtureReference.trim()))
      throw Error('Every window needs schedule provenance');
    if ((Date.parse(p.end) - Date.parse(p.start)) % p.intervalMs)
      throw Error('Window boundaries must align with observation slots');
    if (p.origin === 'https://goon-squad-data.gs-wc.workers.dev' && p.intervalMs < 60000)
      throw Error('Current Worker requires a >=60s probe interval');
    if (i && (p.start !== windows[i - 1].end || p.origin !== windows[0].origin
      || p.intervalMs !== windows[0].intervalMs || !isDeepStrictEqual(p.competitions, windows[0].competitions)))
      throw Error('Windows must be contiguous with the same origin, cadence and competitions');
  }
  return { windows };
}

async function freeze(path, value) {
  const bytes = JSON.stringify(value) + '\n';
  let file;
  try { file = await open(path, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (await readFile(path, 'utf8') !== bytes) throw Error(`Frozen evidence differs: ${path}`);
    return;
  }
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  const directory = await open(resolve(path, '..'), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function ledgerReady(path) {
  try {
    if ((await stat(path)).size > 64 * 1024 * 1024) throw Error('Ledger exceeds recovery limit');
    return (await readFile(path)).includes(10);
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function main(input, output, ...extra) {
  if (!input || !output || extra.length) throw Error('Use run-score-monitor.py schedule MANIFEST DIRECTORY');
  requireMonitorLock(`${output}.schedule.lock`);
  const schedule = validateSchedule(JSON.parse(await readFile(input, 'utf8')));
  const destination = alertDestination(process.env.SCORE_ALERT_URL);
  await mkdir(output, { recursive: true });
  // Freeze the complete schedule before starting any probes, including on restart.
  await freeze(join(output, 'schedule.json'), { ...schedule, destination });
  const tasks = [];
  for (const [i, plan] of schedule.windows.entries()) {
    const prefix = join(output, String(i + 1).padStart(2, '0'));
    const path = `${prefix}-plan.json`;
    await freeze(path, plan);
    tasks.push({ plan, path, ledger: `${prefix}-observations.jsonl`,
      state: `${prefix}-alerts.json`, recordDone: false, watchDone: false, retryAt: 0 });
  }
  let stopped = false, failure;
  const running = new Set();
  const stop = () => { stopped = true; };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  function launch(task, mode) {
    const args = mode === 'record' ? [task.path, task.ledger] : [task.ledger, task.state];
    const child = spawn('python3', [fileURLToPath(new URL('./run-score-monitor.py', import.meta.url)), mode, ...args],
      { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, NODE_BINARY: process.execPath } });
    task[mode] = child; running.add(child);
    child.once('error', error => { failure = error; });
    child.once('close', code => {
      running.delete(child); task[mode] = null;
      if (stopped) return;
      if (code === 0) task[mode === 'record' ? 'recordDone' : 'watchDone'] = true;
      else if (mode === 'watch' && code === 2) task.retryAt = Date.now() + 5000;
      else failure = Error(`${mode} failed for ${task.path}: ${code}`);
    });
  }
  try {
    while (!stopped && !tasks.every(t => t.recordDone && t.watchDone)) {
      if (failure) throw failure;
      const now = Date.now();
      const active = task => now >= Date.parse(task.plan.start) - 5000 && now < Date.parse(task.plan.end);
      const ordered = [...tasks].sort((a, b) => {
        return Number(active(b)) - Number(active(a)) || Date.parse(a.plan.start) - Date.parse(b.plan.start);
      });
      for (const task of ordered) {
        // Prestart the next recorder so alert draining cannot delay its first slot.
        if (Date.now() < Date.parse(task.plan.start) - 5000) continue;
        if (!task.record && !task.recordDone && tasks.filter(t => t.record).length < 2) launch(task, 'record');
        if (!task.watch && !task.watchDone && tasks.filter(t => t.watch).length < 4 && Date.now() >= task.retryAt
          && await ledgerReady(task.ledger))
          launch(task, 'watch');
      }
      await sleep(100);
    }
    if (failure) throw failure;
    if (stopped) process.exitCode = 2;
    console.log(JSON.stringify({ windows: tasks.length, completed: tasks.filter(t => t.recordDone && t.watchDone).length, stopped }));
  } finally {
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    stopped = true;
    await Promise.all([...running].map(child => new Promise(resolveExit => {
      child.once('close', resolveExit); child.kill('SIGTERM');
    })));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(...process.argv.slice(2));
