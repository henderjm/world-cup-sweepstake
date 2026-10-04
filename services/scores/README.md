# Stored score service

Local implementation of the snapshot contract, DynamoDB storage adapter and
read-only API, plus shared request admission, a bounded provider client and a
runnable collector. No production route uses this service yet. Migration of
existing consumers, cloud deployment and operational monitoring remain unfinished.

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
already in flight. Request admission below coordinates consumers of this store;
existing Worker and GitHub provider calls have not been migrated to it.

Install the service's pinned dependency independently of the frontend:

```sh
npm ci --prefix services/scores
```

## Provider admission and transport

One table represents one provider account. `PROVIDER_BUDGET` holds the persisted
policy, UTC day, counted attempts, pacing/cooldown deadlines and current permit.
Budget writes share the same lease and version-conditional transaction as score
publications. Never create independent budgets for different leagues, processes
or API keys belonging to the same account.

`initializeBudget(lease, { dailyLimit, minuteLimit, scoreReserve }, used)` is a
one-time cutover operation, not routine collector startup. It requires explicit
limits and verified usage for the current UTC day, and refuses to replace an
existing budget. Pause other consumers before observing usage and initializing;
reserve any uncertain in-flight usage. The first minute admits no calls, allowing
previous minute activity to drain. A missing/corrupt budget or unavailable database
fails closed. Current production readers still bypass this admission, so this
does not yet establish account-wide control of the deployed app.

`ScoreProvider.request(lease, path, { priority })` reserves an attempt before
dispatch. Only explicit `priority: "scores"` can consume the score reserve;
unclassified requests default to supplementary. Every retry requires a new
reservation. Denial returns `{ allowed: false, reason, retryAt }` without making
an HTTP request; the future scheduler must return to its priority queue rather
than sleeping inside an optional request. The client performs no hidden retries.

Only one request permit is active at a time. Successful completion permits the
next request after a gap based on both the minute limit and its conservative
whole-number per-second rate. A crashed caller occupies its full dispatch/body
deadline plus the gap. Timeouts and lost replies are never refunded. The client
refuses expired dispatch permits and requires a lease covering the request
deadline; conditional admission prevents a replaced collector acquiring more.
This still cannot revoke an HTTP request already sent before takeover.

The direct API-Football client uses a fixed HTTPS origin, refuses redirects,
allows at most five seconds including streamed body reads, and caps bodies at
8 MiB. It reuses the existing API envelope/error validation. Successful
`observedAt` is captured after body validation, before database bookkeeping;
it remains a collection timestamp, not proof of upstream event freshness.
The collector additionally validates competition, season, pagination and expected
fixture coverage before mapping/publishing.

Provider quota headers can lower the configured limits and increase counted
usage, never refund an attempt or automatically authorize a higher plan.
HTTP 429, HTTP 200 quota errors and a zero minute allowance impose at least a
60-second shared cooldown. Other failures back off from one to 30 seconds;
`Retry-After` can extend the cooldown, capped at 24 hours. The direct dashboard
subscription resets daily usage at UTC midnight; admission avoids requests whose
deadline would cross that boundary and retains pacing/cooldowns across it. This
UTC policy is not suitable for a RapidAPI subscription's different reset rules.
[Provider rate limits](https://www.api-football.com/news/post/how-ratelimit-works),
[subscription reset rules](https://www.api-football.com/terms).

## Runnable collector

`collector.mjs` rebuilds a priority queue from stored observations after each
action. It claims/renews a unique process lease and performs at most one budgeted
HTTP request per step. Another owner stays passive. Jobs run in this order:

1. Live or overdue non-terminal fixtures, every 15 seconds in batches of up to
   20 IDs. A failed batch keeps its own scores and observation times while other
   batches can progress. Halftime, extra time and penalties remain live jobs.
2. Complete season discovery every 15 minutes, including after midnight. Pages
   accumulate without publication until complete; pages must agree, contain
   unique IDs and match the configured competition/season. Discovery is bounded
   to 20 pages, 2,000 fixtures and two minutes. Losing known fixtures rejects the
   new snapshot. A restart discards unfinished pages and starts discovery again.
3. Fixtures within two hours of kickoff, every 15 minutes with the next refresh
   clipped to kickoff. Terminal results leave live polling but remain subject
   to discovery, which can apply later provider corrections.
4. Standings every 15 minutes, using supplementary allowance. Invalid or
   truncated tables retain the saved table; fetching a table never advances
   score-observation timestamps.

Failed jobs wait 30 seconds before re-entering the queue; shared provider
cooldowns may delay them further. Failures log the job and failing phase without
dumping provider bodies or credentials. The loop wakes at least every five
seconds to maintain its lease and re-evaluate due work. These are configured
cadences, not a measured source-to-screen latency guarantee. A cold, validated
empty response has no independent expected-fixture inventory; seed/compare
known schedules during shadow rollout before trusting that absence in production.

Run only against an already provisioned table and initialized budget:

```sh
SCORE_TABLE_NAME=your-approved-table SCORE_SEASONS=PL:2026,CL:2026 \
  AWS_REGION=eu-west-1 npm run collect --prefix services/scores
```

Supply `API_FOOTBALL_KEY` through the process's secret environment, not command
arguments or committed files. The process creates no infrastructure or budget.
SIGINT/SIGTERM stops scheduling and lets the bounded in-flight operation finish.
The lease then expires naturally; it is never deleted to accelerate takeover.

For local tests, set **both** `SCORE_DYNAMODB_ENDPOINT` and
`SCORE_PROVIDER_ENDPOINT` to loopback HTTP URLs. The runner rejects other local
overrides and uses synthetic credentials even if a real key is in the shell.
No new account, plan or cloud resource is needed for the test path. The runtime
entrypoint test starts this process against local services, observes publication
and checks a clean SIGTERM exit.

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
removes it. Nine storage integration cases cover eight competing Node processes, renewal,
takeover, a delayed old transaction, concurrent publications, a lost write reply,
adapter reconnection, invalid writes, unavailable storage and 100 read-only API
requests. Seven budget policy cases cover admission, protected score allowance,
second/minute pacing, conservative quota reconciliation, backoff and UTC rollover.
Ten local HTTP/database cases verify competing callers, uncertain admission,
takeover, cooldown, stalled/oversized/malformed bodies, redirects and a mapped
score progressing from 1–0 to 2–0 before an outage preserves its original age.
The separate restart check verifies persisted scores, generations, counted
requests and cooldown after an actual database process restart. It uses an
injected clock to exercise expiry without wall-clock sleeps. This is not AWS availability-zone,
network-partition, IAM, throughput or sustained matchday reliability evidence.

Nine collector tests additionally cover partial batches, paginated discovery and
its restart, identity/status validation, known-fixture retention, quota recovery,
PL/CL separation, midnight scheduling, match transitions, table retention and the
actual CLI process. All 35 service checks use local storage and synthetic HTTP.

For headless validation through the actual collector and database, keep DynamoDB
Local and the site preview on :8742 running, then use:

```sh
node scripts/qa/collector-server.mjs
node scripts/qa/run-headless.mjs scripts/qa/collector.js
```

The QA server binds to localhost:8743, owns disposable test tables and a local
provider server, and deletes its tables on SIGINT/SIGTERM. Stop it before stopping
DynamoDB. The browser checks retry, validated empty discovery, loading, stale
score retention and recovery, 390/1440px layouts and absence of provider calls
from viewers. No visible browser or production provider request is used.

Next: migration of every existing provider consumer and independent monitoring.
Review whole-season payload size and read cost against the planned hot-record
layout before claiming scalable infrastructure. Price and seek approval for cloud
infrastructure before validating AWS failover and a controlled production cutover.
