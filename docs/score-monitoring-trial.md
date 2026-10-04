# Independent score monitoring trial

Draft, 4 October 2026. No account creation, spending, alert delivery or deployment
is authorized by this document. The existing recorder and watcher have passed
local failure/restart checks but are not an installed continuous monitor.

## Proposed host and cost

Run the score recorder and durable alert watcher outside AWS and Cloudflare.
A DigitalOcean Basic regular 1 GiB/1 vCPU VM is a candidate at $6/month, including
25 GiB disk and 1,000 GiB transfer. This is a sizing assumption, not a capacity
result. The published daily backup option is 30% of VM price, adding $1.80/month;
backups do not replace per-window evidence replication or uninterrupted alerting.
[DigitalOcean pricing](https://www.digitalocean.com/pricing/droplets), checked
4 October 2026. Candidate host plus daily backup: $7.80/month before tax.

Use public stored-read endpoints and an unprivileged service account. The monitor
needs no provider secret, D1 credentials or DynamoDB access. Keep outbound alert
credentials in a restricted environment file. Do not open a public alert receiver
on the same host and call that an independent watchdog.

## Probe and evidence contract

For the approved stored service, use one PL and one CL probe every five seconds, matching the reliability contract.
A 30-day month adds 1,036,800 API requests, before any browser journeys or watchdog
traffic. At the current 200 KiB response assumption, that is 197.75 GiB of outbound
AWS data, costing $17.80 in transfer alone without free allowances. The cost calculator now adds these
requests to each visitor-traffic scenario; do not add them a second time. The existing provider-backed Worker remains protected by
its 60-second sampling minimum until stored mode is approved and verified.

Record missing slots, HTTP failure, slow responses, worst active-fixture source
age, and fixture completeness against a separately verified schedule inventory.
A 200 response and recently collected timestamp do not prove the provider has
reported every on-field change. Keep provider-visible-to-screen measurement and
headless browser usability checks separate from API observation freshness.

Plans cover at most 24 hours each and the watcher caps each ledger at 64 MiB.
The explicit schedule runner below now resumes those windows and hands over to
the next planned window while retaining pending alerts. Continuous external
supervision, bounded historical retention and schedule renewal remain open.
A service manager must terminate the entire process group after a crash before
restarting the locked wrapper. Benchmark disk, memory and CPU before selecting
the VM size. Preserve at least 30 days and three busy windows for the report.

## Receiver and watchdog decision

Pushover is a candidate for operator phone notifications at $4.99 once per
receiving platform; a 30-day trial is advertised. This is not a purchased or
configured channel. [Pricing](https://pushover.net/pricing), checked 4 October.
Its emergency API supports retries/expiry and a receipt that can be queried for
user acknowledgment. Implement a durable adapter from our event-ID acknowledgment
contract; a Pushover API success is provider acceptance, not proof a person saw
the alert. Confirm the intended recipient/device before sending anything.
[API](https://pushover.net/api), [receipts](https://pushover.net/api/receipts).

Healthchecks.io advertises a free tier for 20 checks, but its API requires at
least 60 seconds each for period and grace. Therefore its shortest periodic
configuration reaches the down threshold two minutes after the last successful
ping, before notification delivery delay. It cannot be the sole detector for
our 60-second alert target. It may be an additional slower fallback; do not
silently weaken the target to adopt it. [Pricing](https://healthchecks.io/pricing/),
[API limits](https://healthchecks.io/docs/apiv1/), checked 4 October.

Select and price a watchdog outside both the score service and monitor host
that can detect missed monitor progress inside the remaining alert budget.
A heartbeat must mean the planned probe/alert pipeline is advancing, not merely
that a timer process is alive. Probe failure must still advance evidence and
produce an incident; it must not make the watchdog confuse a score outage with
a healthy monitor. Preserve direct monitor-loss alerting if the primary receiver
adapter is unavailable. This watchdog/receiver integration remains unresolved.

## Acceptance before asking to operate it

- Prove unattended rollover, crash/restart, interrupted append, pending alert
  retry, exhausted disk and retention without losing original observation ages.
- Kill the recorder, watcher and entire host separately; time detection and
  actual approved device receipt. Retain receipt and recovery evidence.
- Inject stale HTTP 200, missing fixture, API outage and recovery for PL and CL.
  Headless mobile/desktop journeys must show honest stale/unavailable states.
- Measure resource usage and complete VM, replication, watchdog, paging and
  provider-plan pricing. Confirm the account, operator and recipient before use.

The $7.80 host/backup candidate plus $4.99 one-time receiving-platform price is
only part of monitoring cost. It does not complete the spending proposal or
establish end-to-end reliability. Next engineering work is the continuous
supervisor and real receiver adapter; watchdog selection remains a design gate.

## Implemented recorder recovery

`python3 scripts/run-score-monitor.py record PLAN.json LEDGER.jsonl` starts or resumes
one approved window. It requires Python 3 on a POSIX host and Node (or an explicit
NODE_BINARY). The wrapper holds a nonblocking OS file lock, inherited by the Node
child, so process exit releases ownership without deleting stale PID files.
Keep the `.recorder.lock` inode; do not unlink it while any recorder may run.
Use a local filesystem with working POSIX flock semantics, not shared/network
storage. Restart the wrapper with the same paths after process failure.

Only ledgers created by this locked wrapper can resume. Legacy `record` outputs
remain reportable but cannot resume because their original writer had no lock.
An altered plan or complete corrupt record fails without rewriting evidence.
Only an unterminated final append is truncated; completed probes are preserved,
missed slots remain missing, and future probes continue without duplicate slots.
An interrupted initial plan remains an error requiring review, not invented data.

Four new process/file recovery cases plus existing recorder/alert tests passed
(34 total), including actual HTTP recording across termination and restart. This
also covers watcher crash recovery via
`python3 scripts/run-score-monitor.py watch LEDGER.jsonl STATE.json`.
Overlapping watchers are rejected and pending alerts retry after process-group
termination without lock deletion. The explicit schedule runner below now handles next-window handover. Retention,
external supervisor installation and deployment remain open.

## Explicit schedule runner

`python3 scripts/run-score-monitor.py schedule MANIFEST.json EVIDENCE_DIRECTORY`
runs a finite, approved schedule. The manifest is `{ "windows": [PLAN, PLAN] }`,
using the recorder plan shape. Supply 1–31 contiguous windows, each no longer
than 24 hours, with aligned observation slots, the same origin/cadence/competition
list and nonempty `fixtureReference` provenance. Reconcile each window's fixture
list independently, including matches still underway across the boundary. The
runner does not discover fixtures, infer a finished match or generate future plans.
Use an existing parent directory on durable local POSIX storage.

The runner freezes the normalized schedule and destination before any probes.
Restart requires exactly the same schedule and receiver. Each window has its own
immutable plan, append-only ledger and durable alert state. Recorders start up to
five seconds early; a previous window's refused alerts drain separately while
new probes continue. Receiver exit code 2 retries after five seconds, preserving
per-event backoff. A corrupt ledger, changed plan or unexpected child failure
stops the runner and terminates its children. Missed slots remain missing.

Concurrency is bounded to two recorders and four watchers. Current measurement
windows take priority over historical recovery; a backlog can delay historical
alerts. This is not a guarantee of the 60-second paging objective. Incidents are
scoped to each window: an unresolved incident at a boundary is not fabricated into
a recovery, and the next window may create a separate incident. Receiver display
must retain window/event time and must not infer cross-window recovery.

The schedule lock is inherited from the wrapper. Use supervisor process-group
or cgroup termination to stop all descendants after a crash. On orderly stop,
children are signalled and awaited. Re-run the same command to recover evidence.
The runner exits after all windows and pending deliveries finish; it does not
silently extend the schedule. A receiver that never accepts leaves it running.
No evidence is automatically deleted. Retention, external process supervision,
heartbeat-loss detection, schedule renewal and actual paging remain required.

Local verification: `node --test test/score-schedule.test.js` exercises adjacent
PL/CL windows with active fixtures, refused alerts across handover, original-ID
retry, concurrent-runner exclusion, restart without duplicate probes or delivery,
and refusal to rewrite an existing schedule. It uses local HTTP only.

## Disk-full alert-state recovery

The alert writer now removes its temporary file when writing or syncing fails,
as well as after rename. Previously an ENOSPC failure skipped that cleanup.
A real 64 KiB Linux tmpfs reproduced the leak before the fix. Three consecutive
failed attempt writes now preserve the exact committed state, leave no temporary
files and send no events before the attempt is durable. After freeing test space,
both pending competition alerts retry with their original IDs and persist their
acknowledgments. This verifies alert-state persistence; it does not prove recorder
append recovery under ENOSPC, host-loss detection or delivery to a human device.

Reproduce using an existing local Node 24 image (no network). The test refuses
non-tmpfs filesystems and volumes larger than 1 MiB, and is skipped in the ordinary
suite unless the explicit disposable directory is supplied:

```sh
docker run --rm --platform linux/amd64 --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 \
  --tmpfs /evidence:rw,size=64k,uid=1000,gid=1000,mode=700 \
  --mount type=bind,src="$PWD/scripts",dst=/work/scripts,readonly \
  --mount type=bind,src="$PWD/src",dst=/work/src,readonly \
  --mount type=bind,src="$PWD/test",dst=/work/test,readonly \
  -e SCORE_ALERT_DISK_TEST_DIR=/evidence -e SCORE_RECORDER_DISK_TEST_DIR=/evidence \
  node:24-bookworm-slim node --test --test-concurrency=1 \
  /work/test/score-alert-disk.test.js /work/test/score-recorder-disk.test.js
```

The recorder also rechecks wall time after every timer wake-up so an early wake
cannot produce a pre-slot observation that the evaluator rejects. A deterministic
early-wake test covers the wait; schedule integration now checks both early and
late starts and includes event diagnostics on failure. Final related suite:
33 passed, plus the separately enabled real ENOSPC test. One earlier schedule
run emitted four accepted events instead of two; three subsequent repetitions
passed before the timing change, so its root cause is unconfirmed. Do not claim
that intermittent failure is conclusively fixed; retain diagnostics on recurrence.

## Recorder disk-full recovery

The same disposable 64 KiB tmpfs now exercises recorder append failure with a
real ENOSPC and a partial JSONL tail. Thirty synthetic active fixtures per
competition make the failed write cross a filesystem block. Completed PL/CL
observations remain byte-for-byte intact. Once test space is released, restart
truncates only the partial tail and resumes future slots. Missed slots continue
to reduce both competitions' coverage; another restart neither rewrites evidence
nor repeats probes. No provider calls are made.

This container uses `flock` to hold the same inherited descriptor protocol because
the existing Node image does not contain Python. The Python wrapper's process
recovery is covered separately by `score-recorder-resume.test.js`. Run the two
disk tests serially as shown above: they deliberately fill the whole disposable
volume. Both refuse non-tmpfs and volumes above 1 MiB. This proves local recorder
append recovery, not power-loss durability, automatic disk reclamation, external
supervision, watchdog detection or human receipt of an alert. Retention and those
operational gates remain open.

Observed local result: two durable probe records preserved, 2,406 partial bytes
removed, eight final records, and 66.67% monitor coverage for each competition
(two missed slots out of six). Both disk tests and all four Python-wrapper
recovery tests passed. These synthetic values demonstrate honest gap accounting,
not the app's production availability.
