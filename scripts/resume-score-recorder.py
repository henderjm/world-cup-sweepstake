#!/usr/bin/env python3
"""Run one recoverable observation window under a crash-released POSIX lock."""
import fcntl
import os
from pathlib import Path
import signal
import subprocess
import sys

if len(sys.argv) != 3:
    raise SystemExit('Usage: python3 scripts/resume-score-recorder.py PLAN.json LEDGER.jsonl')
plan, ledger = map(lambda value: str(Path(value).resolve()), sys.argv[1:])
# Keep the inode: unlinking a lock can let another process lock a different file.
with open(ledger + '.recorder.lock', 'a+') as lock:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit('Another recorder owns this ledger')
    env = dict(os.environ, SCORE_RECORDER_LOCK_FD=str(lock.fileno()))
    script = Path(__file__).resolve().with_name('measure-score-reliability.mjs')
    child = subprocess.Popen([os.environ.get('NODE_BINARY', 'node'), str(script), 'resume', plan, ledger],
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
