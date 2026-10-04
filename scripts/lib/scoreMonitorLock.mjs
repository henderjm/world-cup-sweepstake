import { fstatSync, statSync } from 'node:fs';

export function requireMonitorLock(path) {
  const fd = Number(process.env.SCORE_MONITOR_LOCK_FD);
  if (!Number.isInteger(fd) || fd < 3) throw Error('Monitoring requires scripts/run-score-monitor.py');
  const held = fstatSync(fd), expected = statSync(path);
  if (!held.isFile() || held.dev !== expected.dev || held.ino !== expected.ino)
    throw Error('Monitor lock does not match output');
}
