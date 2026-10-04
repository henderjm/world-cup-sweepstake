# Stored score service

Local implementation of the snapshot contract, DynamoDB storage adapter and
read-only API for the planned collector. No production route uses this service
yet. The provider polling loop and account-wide request budget are unfinished.

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

**The storage adapter must enforce the following atomically.** Calling
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

## DynamoDB adapter

`DynamoScoreStore` in `dynamodb.mjs` takes an injected AWS SDK v3 DynamoDB client,
table name and optional clock/request timeout. The table has one string partition
key, `pk`, and no sort key. It uses a persisted `COLLECTOR` lease plus separate
`SCORE#competition#season` items. The runtime does not create or delete tables.
Construct the public API with `readSnapshot: (code, season) => store.read(code, season)`.
Its deployment role must have only `GetItem`; the collector role additionally
needs conditional `PutItem` and the permissions required for transaction checks.

`claim(owner)` conditionally acquires or renews a 30-second lease; contention
returns null. Use a unique process-instance ID as owner, never a shared hostname
or service name. Renew before expiry and stop work when renewal fails. The epoch
increases after expiry and survives restart. Never delete or TTL the lease item:
that would reset its fencing history. Each `publish(lease, input)` transaction
checks the current owner/epoch/expiry and expected snapshot version together.
Strongly consistent base-table reads expose whole committed snapshots. See
[DynamoDB transactions](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html).

Requests have a three-second default timeout, and publication requires that much
lease headroom. Expiry comparisons use the application clock, not a database
server clock. Production needs synchronized clocks and verified request/renewal
timing. Aborting an SDK request does not prove that a submitted write failed:
after an uncertain outcome, read the lease/snapshot again before deciding what
to do. SDK retries of the same transaction retain its idempotency token; a new
publication still checks its original base version. A replacement owner fences
the previous owner's delayed transaction, but this does not fence provider calls
already in flight. Account-wide admission remains separate unfinished work.

Install the service's pinned dependency independently of the frontend:

```sh
npm ci --prefix services/scores
```

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

### Actual database checks

The service integration suite uses the official SDK against
[DynamoDB Local](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.DownloadingAndRunning.html).
It refuses non-loopback endpoints and uses synthetic credentials. It creates and
deletes only randomly named test tables. Run a disposable database bound to
localhost (the pinned image used for the October 4 evidence is version 3.3.1):

```sh
docker run --rm -d --name kickoff-score-dynamodb-test --memory=512m --cpus=2 \
  -p 127.0.0.1:18043:8000 \
  amazon/dynamodb-local@sha256:ff89bd48ff32cd8d9be5fee8873b65b8854dc408f1afe881be6eb00247bc0dab \
  -jar DynamoDBLocal.jar -sharedDb
npm run test:integration --prefix services/scores
node services/scores/test/restart.mjs write /tmp/kickoff-score-restart-new.json
docker restart kickoff-score-dynamodb-test
# Wait for database initialization before verification.
node services/scores/test/restart.mjs verify /tmp/kickoff-score-restart-new.json
docker stop kickoff-score-dynamodb-test
```

Use a new manifest path for each restart check. The database writes to its
container filesystem, so restart retains data; stopping this disposable container
removes it. Nine integration cases cover eight competing Node processes, renewal,
takeover, a delayed old transaction, concurrent publications, a lost write reply,
adapter reconnection, invalid writes, unavailable storage and 100 read-only API
requests. The separate restart check verifies persisted scores and generations
after an actual database process restart. This is not AWS availability-zone,
network-partition, IAM, throughput or sustained matchday reliability evidence.

Next: collector discovery/polling, global admission and request budgets, priority
scheduling, and independent monitoring. Price and seek approval for cloud
infrastructure before validating AWS failover and a controlled production cutover.
