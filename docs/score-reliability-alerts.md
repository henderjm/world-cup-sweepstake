# Score reliability alert watcher

The watcher is a separate foreground process alongside the bounded API recorder.
It reads the recorder's durable observation ledger and delivers incident and
recovery events to an explicitly configured receiver. It never fetches scores or
contacts the provider. This is locally verified monitoring software, not an
installed external monitor, a human paging channel or a production SLO claim.

## Run a measurement window

Create the reconciled fixture plan described in `score-reliability-recorder.md`.
Run the recorder with a new ledger filename on durable storage. Once its initial
plan line has been written, start the watcher in a second process:

```sh
python3 scripts/run-score-monitor.py record /path/plan.json /path/observations.jsonl
```

```sh
python3 scripts/run-score-monitor.py watch /path/observations.jsonl /path/alert-state.json
```

The watcher requires `SCORE_ALERT_URL` from the process environment. Configure an
approved HTTPS receiver, or loopback HTTP for synthetic tests. Credentials and
query parameters in the URL are rejected. Optional `SCORE_ALERT_TOKEN` supplies a
Bearer authorization header; use secret injection, never commit or print it.
Do not point tests at a real messaging destination without authorization.

Only one watcher may own an alert-state path. The Python wrapper acquires a
nonblocking POSIX lock on `.watcher.lock`, inherited by its Node child.
SIGINT/SIGTERM finish bounded delivery and save evidence. Ownership ends when
both processes exit, including after a crash; restart with the same paths and
destination. Never unlink the persistent lock inode. Supervisors must terminate
the whole process group: killing only the wrapper leaves the child holding ownership.
Use a persistent local filesystem with POSIX flock semantics, not network storage.
This is not a distributed lock. A legacy `.lock` file blocks startup: verify its
old watcher has stopped before removing that legacy file once. Preserve alert state.

## Detection and delivery contract

- Evaluate closed observation slots every second, using the same fixture,
  timeliness and usable-API rules as the report. A dead or stalled recorder
  produces missing-observation incidents instead of silently improving coverage.
- Open one incident per affected competition. Missing/invalid/unconfirmed
  expected fixtures, stale observations and unusable/slow API responses fail.
  A subsequent healthy slot sends recovery with the same incident identity.
  Continued failure does not generate repeated pages. Per-fixture details remain
  in the observation ledger and report; a new failing fixture within an existing
  incident does not create another notification.
- An old idle schedule alone is not a live-fixture freshness incident. With no
  eligible fixtures, freshness remains unmeasured. API failures still alert.
- Persist the event before sending. Event IDs are deterministic for the plan,
  competition, slot and transition. Retry delays are 5, 10, 20 and then 30 seconds.
  Persist attempts and the next retry time before each send. A blocked PL
  delivery does not prevent CL delivery; incident precedes recovery within each
  competition.
- Each POST, including its acknowledgment body, has a two-second deadline and a
  4 KiB acknowledgment limit. Redirects are refused. HTTP success alone does not
  count as receipt: the response must contain `{"acceptedEventId":"<event id>"}`.
  Send the same ID in the `Idempotency-Key` header. The receiver must durably
  accept and deduplicate events before acknowledging them. An ambiguous response
  or crash after acceptance may resend the same ID: this is at-least-once
  delivery, not exactly once.
- The acknowledgment proves acceptance by that receiver only. The production
  adapter must separately prove delivery to the chosen paging destination and
  retain its downstream receipt. No email, Slack or other human channel was
  configured or contacted by this implementation.

Event bodies include `schema`, `id`, `incidentId`, `competition`, `kind`,
`scheduledAt`, `detectedAt`, failure reasons and affected fixture IDs. They omit
credentials, raw responses and scores. A restarted watcher may replay historical
transitions; receiver presentation must retain event time and recovery ordering.
The state records attempts, retry times and receiver acknowledgment times.

Closed-slot detection adds up to one sampling interval plus the watcher tick.
At the intended five-second stored-API interval, a healthy receiver is normally
contacted within another two seconds. This is a design bound under a functioning
host/network, not a measured production guarantee. The existing Worker requires
60-second probes to protect quota and cannot satisfy the same detection target.

## Evidence and failure handling

The ledger's complete prefix is hashed on every pass. Rewriting/truncating the
observed prefix, changing the plan/destination, malformed complete records and
duplicate observations stop the watcher. An incomplete final append is ignored
until completed. Slots already processed as missing are never retrospectively
changed into a healthy alert history because a record arrived late.

State carries a checksum to detect accidental edits/corruption and is written to
a new mode-0600 file, flushed, atomically renamed and its directory flushed.
The checksum is not an authentication mechanism. Failed persistence prevents new sends. Keep the observation
ledger and alert state together: the latter is the durable delivery evidence.
Do not reset it to clear an error or blindly delete an unacknowledged event.

Limits: 64 MiB observation ledger and 1,000 retained transition events per state.
Exceeding a limit fails visibly without deleting evidence; split future windows
and investigate excessive flapping. The watcher rescans the bounded ledger; its
busy-window CPU/memory and storage budget still require deployment sizing.

After the final slot closes, drain pending events for up to 60 seconds. Exit code
0 means all generated events were acknowledged, **not** that the scores were
healthy; the summary includes open incidents. Code 2 means unacknowledged events
remain durably queued. Code 1 is an execution/configuration failure. Restarting
after the window can retry pending delivery, preserving IDs and backoff.

An external supervisor must observe watcher exit and heartbeat loss. A watcher
cannot report its own host failure to its receiver. Hosting, watchdog, storage
retention, approved downstream paging, recurring reconciled plans and browser
measurements remain deployment work. Keep that monitor outside the score
collector's failure domain. A paused Codex automation is not such a supervisor.

## Local verification

```sh
node --test test/score-alerts.test.js test/score-reliability.test.js
```

The real-process test runs a synthetic score endpoint, recorder, watcher and
receiver. It injects stale data, rejects the first alert, kills the watcher,
rejects an overlapping watcher, then restarts with its preserved state without
manual lock deletion. It also kills the recorder: missing planned checks reach the receiver.
Receipt evidence checks the original retry ID, incident/recovery order and all
three distinct acknowledged events. All receipt delays in that local test are
under ten seconds; this is not a busy-matchday or external paging measurement.
