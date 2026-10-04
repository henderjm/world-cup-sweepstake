#!/usr/bin/env python3
"""Run a recorder or alert watcher under a crash-released POSIX lock."""
import fcntl
import os
from pathlib import Path
import signal
import subprocess
import sys

if len(sys.argv) != 4 or sys.argv[1] not in ('record', 'watch'):
    raise SystemExit('Usage: python3 scripts/run-score-monitor.py record PLAN LEDGER | watch LEDGER STATE')
mode = sys.argv[1]
first, second = map(lambda value: str(Path(value).resolve()), sys.argv[2:])
if mode == 'watch' and Path(second + '.lock').exists():
    raise SystemExit('Legacy watcher lock exists; verify the old watcher stopped before removing it')
lock_path = second + ('.recorder.lock' if mode == 'record' else '.watcher.lock')
# Keep the inode: unlinking a lock can let another process lock a different file.
with open(lock_path, 'a+') as lock:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit('Another monitor process owns this output')
    env = dict(os.environ, SCORE_MONITOR_LOCK_FD=str(lock.fileno()))
    script = Path(__file__).resolve().with_name('measure-score-reliability.mjs' if mode == 'record' else 'watch-score-reliability.mjs')
    args = ['resume', first, second] if mode == 'record' else [first, second]
    child = subprocess.Popen([os.environ.get('NODE_BINARY', 'node'), str(script), *args],
                             env=env, pass_fds=(lock.fileno(),))
    def stop(signum, _frame):
        if child.poll() is None:
            child.send_signal(signum)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        code = child.wait()
    finally:
        if child.poll() is None:
            child.terminate()
            child.wait()
    raise SystemExit(code if code >= 0 else 128 - code)
