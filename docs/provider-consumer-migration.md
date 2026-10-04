# Provider consumer migration

Source inventory, 4 October 2026. This describes the checked local source, not a
runtime traffic census. Production configuration is unchanged. The account-wide
budget invariant remains incomplete until every direct caller below is retired
or migrated and runtime evidence confirms no bypass.

## Direct provider entry points

| Entry point | Consumers and data | Current control | Migration and acceptance |
| --- | --- | --- | --- |
| `services/scores/provider.mjs` | New collector: complete season discovery, live/overdue batches, upcoming fixtures and standings | Fenced DynamoDB lease, durable shared daily/minute budget, score reserve, bounded body/deadline and recorded cooldowns | Retain as the single upstream entry point. Add supplementary collection here without changing score priority; verify each endpoint's complete-data rules. |
| `worker/worker.js` `fetchJson` → `fetchWithColoCache` | Shared `getLive`; fixture validation; match detail; live/final fantasy points; notification events; analysis context | Per-isolate pacer, memo and colo cache; quota estimates are not account-wide admission | Score/schedule reads now have an opt-in stored-service path. Detail reads remain direct. Implement stored supplementary data before enabling the full migration and removing the Worker provider key. |
| `scripts/feed-live-details.mjs` `apiGet` | Date discovery and Worker live ingestion; fixture lineups, events and player details for ingestion | Its own pacing/cooldown and optional-detail shedding; GitHub concurrency is separate from the Worker and new collector | Replace with collector publication plus a stored detail adapter; disable the old workflow only after scoreboard, details and notification coverage are verified. Do not run two unbudgeted collectors during shadow/cutover. |
| `internal/apifootball/client.go` through `cmd/api-football` and `scripts/lib/apiFootball.mjs` | `fetch-live-data.mjs` static season/standings/detail/scorer bake; `fetch-fantasy-players.mjs` squads, paginated historical players and historical fixtures | CLI pacing; Go client retries 429 up to four times and has its own HTTP timeout. No shared reservation | Replace provider reads with stored export APIs/jobs. Preserve historical xP, player IDs, final match data and Golden Boot aggregation. Every retry must eventually belong to the shared budget. |

The direct endpoint/key search found those four production entry points. Tests
and QA replay code contain synthetic endpoints and keys; crest URLs are media
reads, not football-data API calls. This is a source inventory, not evidence
that no other environment or account is using the same subscription key.

## Worker score and schedule consumers

All of these call the common `getLive`, so the stored-read switch applies at one
boundary rather than adding different data-selection rules to each feature:

- Public `/PL/live`, `/CL/live` and legacy `/live`.
- `findKnownMatch`: match detail and banter fixture validation.
- `analyseCompetition`: score/status and schedule selection. Its detail reads
  and `generateAnalysis` remain direct-provider consumers.
- `currentFantasyGameweek` and `currentFantasyMatches`: gameweek calculation,
  kickoff locks, waiver scheduling and callers that use these helpers.
- `runScheduledLivePoints` and `runScheduledFantasyScoring`: fixture selection;
  player/event detail required for scoring remains direct.
- `runScheduledFantasyXpBlend`: schedule inputs.
- `notifyCompetition`: fixture selection; event detail remains direct.
- `handlePredictionSet` and `runScheduledPredictionScoring`: prediction fixture
  validation and settlement.

The shared boundary preserves the existing normalized match contract and source
timestamps. The migration does not claim end-to-end validation of every D1
mutation, notification or paid analysis call. Preserve those acceptance gates
when moving supplementary data and before a public cutover.

## Indirect callers and schedules

- `.github/workflows/live-detail-feeder.yml` runs the feeder and may rearm a new
  run. Both scheduled and manual entry points must be accounted for at cutover.
- `.github/workflows/pages.yml` runs live-data and player-pool bakes under its
  conditions, and `scripts/refresh-score-fallback.mjs` reads the public Worker.
  The latter is an indirect provider consumer today; stored mode removes its
  score read's upstream fan-out but does not migrate the full bake.
- Browser/mobile score polls and the bounded reliability recorder use the public
  Worker. Stored mode removes their score-triggered provider calls. Browser
  `/match/:id` requests still need the supplementary migration.
- Worker scheduled jobs can invoke several of the helpers above per tick. A
  single collector account budget must include their replacement jobs, not just
  the public score endpoint. Health probes and manual scripts must follow the
  same rule.

## Implemented opt-in boundary

`worker/stored-scores.js` is used by `getLive` when `SCORE_READ_ORIGIN` is set.
Leave it unset for the existing production path. No value was added to
`worker/wrangler.toml`, and no deployment or secret was changed.

The configured origin must be HTTPS with no credentials, query or path; loopback
HTTP is allowed for local replay. The reader requests `/{competition}/live`
without a provider key. It validates the source, competition, season, version,
writer generation, fixtures, scores and observation coverage. Validated empty
seasons are distinct from unavailable data. It rejects redirects and bounds
headers/body time to four seconds and response size to 4 MiB.

Concurrent identical reads coalesce, but subsequent polls read the service
again. Public responses in this mode use `Cache-Control: no-store`. Last-good
values are isolated by origin, competition and season, bounded to four entries,
and copied before handing them to callers. Lower versions/generations or lost
fixtures cannot replace a known snapshot. Newer versions may correct scores
downward. Recompute age from source observation metadata, including when another
fixture becomes overdue; never reset it to the read time.

On failure, return a labelled last-good stored snapshot if that isolate has one;
otherwise fail. The browser route retains its existing stale cutoff/fallback
behavior. Internal schedule consumers retain their existing last-good access.
There is no fallback to provider calls, feeder overlays or legacy `lastLive`
when stored mode is selected. Isolate loss can lose the memo: the durable score
service remains the authoritative source. This is not multi-region failover.

The Worker still requires its existing provider key because details and other
consumers have not migrated. This switch is a staged migration boundary, not a
claim that the whole Worker is provider-free. Do not enable it publicly before
approved deployment, cloud-read capacity/IAM testing and the remaining product
checks. Rollback must explicitly account for which collector owns the quota.

## Next implementation order

1. Persist and serve lineups/events/player details from collector jobs using the
   supplementary budget. Define separate freshness and missing-coverage fields;
   failed detail must not delay scores or turn unknown statistics into zero.
2. Redirect Worker detail readers, fantasy scoring and notification/analysis
   context to those stored records. Validate live points and terminal settlement
   separately; stale detail must not settle a match as final.
3. Provide stored exports for season/static data, squads and historical xP.
   Migrate scheduled and manually invoked scripts; remove obsolete direct code
   only after equivalent coverage is proven.
4. Prepare the priced cloud trial with independent monitoring, watchdog and an
   approved alert receiver. Shadow reads must share the same provider budget.
5. After approval and busy-window evidence, cut over, verify runtime call counts,
   disable the old feeder/bakes as appropriate and remove unused provider keys.

## Reproducible local checks

```sh
node --test test/stored-score-reader.test.js
```

The focused checks cover empty/unavailable data, response deadlines and size,
source-time preservation, version rollback, lost fixtures, downward correction,
coalescing, mutation isolation, origin/season isolation and real Worker routes.
See `scripts/qa/stored-reader.js` and `stored-reader-server.mjs` for a headless
mobile/desktop replay through the actual Worker with a synthetic stored service.
No real provider traffic is needed for these checks.

## Detail storage foundation — 4 October 2026

`DynamoScoreStore` now supports per-fixture `readDetailManifest`, `readDetail`
and `publishDetail`. Four independently observed sections (fixture, lineups,
events, players) share a small versioned manifest; each payload is bounded to
256 KiB. Publication atomically replaces one section and the manifest under the
existing collector lease and expected version. Reads verify content digests and
retry a whole publication once under the shared read deadline. Missing or
corrupt parts fail rather than becoming successful empty detail.

Section metadata records source observation time, coverage and the result being
observed. `detailCoverage` identifies missing, stale, partial, unpublished and
outdated terminal-result sections. A transition to full time or a later score
correction requires observations against that result; refreshing discovery with
an unchanged result does not invalidate detail. Raw nulls remain null in storage.

This is a storage contract, not provider validation or a settlement change.
The collector must validate endpoint identity and completeness before assigning
coverage. It still needs one-request supplementary scheduling, metadata hydration
on takeover, and last-good handling for partial provider responses. The read
service and Worker must consume these records and propagate degraded sections
before they can protect fantasy settlement. Neither currently uses this path.

All 49 score-service tests passed against DynamoDB Local, including seven detail
checks for restart, age preservation, invalid writes, terminal transitions,
concurrent writers, delayed old-owner writes, mixed-version reads and corruption.
No public deployment, real provider calls or frontend changes were made.

## Detail collector connected — 4 October 2026

The collector now hydrates one fixture manifest at a time, then requests one
fixture/lineups/events/players section per step through the supplementary budget.
Every step rebuilds the score queue first. Live and imminent detail precedes
historical detail; matches more than two hours away and cancelled/postponed
matches do not trigger detail collection. Historical completed matches remain
eligible. Metadata caches clear on lease generation changes and prune fixtures
no longer in configured snapshots. No provider work is triggered by viewers.

Validation checks a single complete provider page, fixture/competition/season
identity, expected teams, lineup identities and player-statistics shape. Empty
pre-match supplementary responses are unpublished. Missing timeline goals or
insufficient lineups/player minutes are partial; initial partial sections retry
after 30 seconds rather than a long finished/lineup cache window. A partial
refresh cannot replace an existing complete section or advance its observation
time. Final status/result changes make all four sections due again. Raw absent
statistics remain null. Coverage is a structural check, not independent proof
that the provider reported every card, substitution or statistic correctly.

All 54 then-existing service checks passed; the final six detail-collector
checks passed after adding pre-match and partial scheduling cases. Tests use
real loopback HTTP and DynamoDB, including quota reserve denial, score
preemption, takeover hydration and final-whistle refresh. Earlier failures were
test-clock pacing and an incorrect expectation of work during an idle interval.

Remaining: serve these records with per-section degraded state and route Worker
match detail, settlement and notification consumers through that service. The
legacy mapper's null-to-zero player-stat defaults require explicit handling in
the stored response. This collector is not deployed; browser behavior and final
settlement are not yet changed by these jobs. Later source corrections remain
subject to the existing finished-detail cache window until a score/status change.

## Stored match-detail endpoint — 4 October 2026

`GET /{PL|CL}/match/{id}` is now served by the read runtime. Only configured
seasons and known score fixtures can read detail. Unknown IDs return 404 without
a detail lookup; database/partition errors return 503. A known fixture awaiting
its first detail collection returns its actual score/header with missing
sections marked degraded, keeping the match openable. Responses use no-store.

The score header always comes from the score snapshot; referee and half-time
scores remain from independently observed fixture detail. Each section exposes
state, observedAt and ageMs. Live-result changes also degrade old fixture,
timeline and player data, rather than pretending that a newly observed score
refreshes them. Legacy endpoint-family names on `degraded` retain compatibility
with the drawer and `isSettleableDetail`. Stale score observations also degrade
`/fixtures`, independently of detail age. Snapshot metadata carries score and
detail versions/generations separately.

Player-stat mapping preserves null minutes and defensive statistics. Missing
participant minutes or missing statistics for a player with recorded minutes
make the player section partial; the existing fantasy settlement guard rejects
that response. Unused bench players are not assumed to have played. This may
expose provider coverage limitations: do not replace missing values with zero to
force settlement; verify source semantics and preserve the limitation visibly.

All 63 score-service tests passed, including eight detail-response checks and
actual reader-process HTTP requests. Tests use DynamoDB Local, exercise fresh,
missing, stale, corrected-result and unavailable states, and call the real
fantasy settlement guard. Full 22-player fixtures exposed and fixed a metadata
size check incorrectly applied to the assembled payload. The database reader
issues only strongly consistent GetItem calls, with no budget/provider access.

Remaining: Worker stored-detail client with bounded requests and version checks,
then migrate public/cron/fantasy/notification readers and validate headless
mobile and desktop journeys. The new service endpoint is not publicly deployed;
production Worker detail reads still use the legacy provider path.

## Worker detail migration — 4 October 2026

`SCORE_READ_ORIGIN` now selects stored match detail as well as stored scores.
The public drawer, live analysis, final analysis, red-card context, provisional
fantasy points and final settlement pass their known competition to the stored
reader. Stored mode does not consult/write the legacy detail KV fallback.
Provider pacing and discretionary provider-budget shedding no longer suppress
these stored reads. Other provider consumers and their API-key guards remain.

The shared `stored-read.js` transport validates the origin, rejects redirects,
sends no provider credentials and bounds headers/body time. Detail reads have a
four-second deadline and 1 MiB response limit. In-flight reads coalesce; later
polls re-read. The last-good detail cache is bounded to 32 entries/4 MiB, with at
most 32 distinct in-flight reads. Identity, status, scores, section observations
and separate score/detail generations are validated. Regressing versions cannot
replace known detail; later downward corrections can. Every failure fallback
marks all four sections degraded, even before the nominal freshness deadline,
and recalculates age from original source observations.

Final settlement retains its existing degraded-data guard. Stored provisional
points skip degraded/substanceless responses; red-card context retains its prior
count when the event section is degraded. The browser no longer fills explicitly
stored missing/empty sections from a legacy static bake: doing so could restore
a goal removed by a later correction. Legacy provider-mode fallback remains.

Validation: 1,635 application tests passed after the final production changes.
Fifteen focused stored-reader checks passed, including the real Worker route,
coalescing, identity/version checks, shared transport deadline and legacy KV
isolation. Wrangler dry-run bundle passed. A fresh isolated frontend preview
contained committed sources plus the match-detail change, excluding unrelated
mobile work. Headless 390px/1440px replay through the actual Worker and service
response mapper passed cold failure/retry, missing sections, loading, lineups,
stale retention, correction from 1–0 to 0–0, focus containment/restoration and
no overflow. Explicit checks forbid static-bake reads after stored responses.
Thirteen stored-service reads, zero provider calls, zero browser errors.

The replay uses synthetic stored payloads, not the real database collector.
Database/collector tests remain separate evidence. A repeated cold-start test
needs a fresh replay process because last-good state intentionally survives in
a warm Worker. Run the replay server once per QA invocation. The production
switch remains unset; no public deployment, paid resources or real notifications
were triggered. Full cron side-effect verification against representative D1
state and real provider coverage remains required before cutover, alongside
remaining feeder/static/player-history consumers and the priced cloud trial.
