import { open, readFile, unlink, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { alertDestination, readLedger, advanceAlerts, saveAlertState, readAlertState, dispatchAlerts } from './lib/scoreAlerts.mjs';

const [ledgerArg, stateArg, ...extra] = process.argv.slice(2);
if (!ledgerArg || !stateArg || extra.length) throw Error('Usage: SCORE_ALERT_URL=<approved receiver> node scripts/watch-score-reliability.mjs <ledger.jsonl> <alert-state.json>');
const ledgerPath = resolve(ledgerArg), statePath = resolve(stateArg);
if (ledgerPath === statePath) throw Error('Evidence and alert state require different paths');
const destination = alertDestination(process.env.SCORE_ALERT_URL);
const lockPath = `${statePath}.lock`;
const lock = await open(lockPath, 'wx', 0o600).catch(error => {
  if (error.code === 'EEXIST') throw Error('Watcher lock exists. Verify its recorded PID is stopped before manually removing the lock; never discard alert state.');
  throw error;
});
let stopped = false;
const stop = () => { stopped = true; };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
try {
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }) + '\n'); await lock.sync();
  let state = await readFile(statePath, 'utf8').then(readAlertState).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  for (;;) {
    if ((await stat(ledgerPath)).size > 64 * 1024 * 1024) throw Error('Ledger exceeds watcher size limit');
    const ledger = readLedger(await readFile(ledgerPath));
    state = advanceAlerts(state, ledger, destination, Date.now());
    const persist = value => saveAlertState(statePath, value);
    await persist(state);
    await dispatchAlerts(state, destination, persist, { token: process.env.SCORE_ALERT_TOKEN });
    const pending = state.events.filter(event => event.acknowledgedAt === null).length;
    const finalSlotEnd = Date.parse(ledger.plan.start)
      + Math.ceil((Date.parse(ledger.plan.end) - Date.parse(ledger.plan.start)) / ledger.plan.intervalMs) * ledger.plan.intervalMs;
    if (stopped || (Date.now() >= finalSlotEnd && !pending) || Date.now() >= finalSlotEnd + 60000) {
      console.log(JSON.stringify({ processedThrough: state.nextAt, events: state.events.length, pending,
        acknowledged: state.events.length - pending, openIncidents: Object.values(state.competitions).filter(c => c.incident).length }));
      if (pending) process.exitCode = 2;
      break;
    }
    await sleep(1000);
  }
} finally {
  process.off('SIGTERM', stop); process.off('SIGINT', stop);
  await lock.close(); await unlink(lockPath);
}
