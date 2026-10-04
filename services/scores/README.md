# Stored score service

Local implementation of the snapshot contract and read-only API for the planned
collector. No production route uses this service yet. There is no AWS adapter,
provider polling loop or account-wide request budget in this directory yet.

`snapshots.mjs` accepts complete normalized fixture snapshots and returns the
existing `/PL/live` or `/CL/live` response shape, with additional version and
per-fixture observation metadata. The producer must assemble snapshots from
validated provider reads using the existing `mapApiFootballMatches` contract;
the module does not fetch the provider or independently reconcile schedules.
An initially empty snapshot is appropriate only after complete, validated
discovery. A later partial/empty response cannot delete known fixtures.

## Write contract

`nextSnapshot(previous, input, { epoch, now })` validates and creates a new
immutable value. `input` contains:

- `competition`, `season`: storage identity; a new season uses a separate key.
- `baseVersion`: version read before the collector's work started; zero for a
  first publication. A stale base cannot overwrite a newer publication.
- `scheduleObservedAt`: when the fixture schedule was successfully observed.
- `fixtures`: complete entries `{ match, observedAt, providerUpdatedAt }`.
  `match` uses the app's normalized shape; `observedAt` is a successful collection
  timestamp in epoch milliseconds. Keep `providerUpdatedAt` null when the
  provider supplies no trustworthy timestamp. A request returning the same score
  can advance `observedAt`; it does not prove the upstream feed is up to date.
- Optional `standings`: `{ rows, observedAt }` in the existing table shape.
  Missing, invalid, older or oversized table updates preserve the saved table
  and its original age without rejecting otherwise valid scores.

All timestamps remain attached to their observations. Old fixture observations
cannot replace newer ones; equal-time changed content is rejected. A genuinely
newer score correction can lower a score. Writes are capped at 300 KiB, with
standings capped at 64 KiB; larger snapshots fail without replacing last-good
data. Production storage may need partitioned fixture records and a manifest
before supporting payloads that exceed this initial bound.

**The future storage adapter must enforce the following atomically.** Calling
`nextSnapshot` in application code alone does not provide concurrency safety:

1. The collector owns the current, unexpired lease and fencing generation.
2. The stored version still equals `baseVersion`.
3. All fixture data is committed before the new version becomes readable.
4. Failed conditions leave the prior value intact. A lease generation must never
   reset after restart; a separate process cannot overwrite it with a local count.
5. Reads of the published version use the intended consistency level, including
   during deployment and failover. Storage failure returns unavailable; it must
   never silently redirect the reader to the provider.

`test/helpers/scoreReplayStore.mjs` is a synchronous, single-process reference
adapter for tests. It models lease expiry and conditional publication. It loses
all state on process exit and cannot coordinate hosts. Its tests are not evidence
of durable storage, distributed fencing, provider-call fencing or AWS failover.

## Read contract and browser compatibility

`createScoreReadApi({ readSnapshot, seasons, now })` returns a Request-to-Response
handler. `readSnapshot(competition, season)` must only read stored data. The API
has no provider client or write endpoint. Missing initial data and storage errors
produce 503; a validated empty collection produces 200 with an empty list.
Unknown competition/season routes are unavailable, and writes are rejected.

The feed age follows the oldest relevant live or overdue scheduled fixture.
An old completed match does not make current matches stale. After 45 seconds of
active-data age the response retains scores with `stale` and `staleAgeMs`.
When idle, schedule age governs freshness with a six-hour threshold. Standings
have their own timestamp and delayed flag. Reads do not change publication time,
version or any observation timestamp, including across midnight and kickoff.

`src/scoreSnapshot.js` compares stored-service versions within one competition
and season. It still uses timestamps for legacy feeds. This distinction matters
when a new version updates one game while another game makes the aggregate age
older: the browser must accept the new score and retain the stale warning, rather
than restoring an older score from local storage. Offline retention recalculates
age from the stored observations as scheduled fixtures reach kickoff. The 24-hour
cache lifetime uses publication time for versioned snapshots, while the displayed
data age continues to use observation time. Old individual observations must not
discard new observations for other games.

## Verification

```sh
node --test test/score-service.test.js test/score-snapshot.test.js
```

The tests cover lease expiry/takeover in the reference adapter, version conflicts,
partial writes, per-fixture ages, genuine corrections, supplementary failures,
identity errors, missing/empty data and 1,000 simultaneous stored reads with zero
provider calls. These are local correctness checks, not a throughput or latency
benchmark of deployed infrastructure.

For headless UI verification, serve a production build on port 8742 and run:

```sh
node scripts/qa/score-service-server.mjs
node scripts/qa/run-headless.mjs scripts/qa/score-service.js
```

The replay publisher binds only to localhost:8743 and uses synthetic CL fixtures.
The browser redirects score reads there and disables static fallbacks. It checks
loading, unavailable, empty, stale, recovery and mixed-age versions at mobile and
desktop widths. No provider key is used. Stop the preview and replay processes
afterwards. See `scripts/qa/README.md` for the headless runner dependency setup.

Next: implement shared durable conditional storage, collector discovery/polling,
global admission and request budgets, priority scheduling, and independent
monitoring. Validate process/network failures against the real adapter, then
price and seek approval for infrastructure and a controlled production cutover.
