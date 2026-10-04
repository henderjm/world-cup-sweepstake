# Live-score reliability acceptance contract

26 September 2026. Engineering targets, not achieved service levels or a customer
SLA. Scope: Premier League and Champions League. Reliability takes precedence
over new features. No new infrastructure, provider purchase or deployment is
authorized by this document.

## Current baseline

We cannot assign an observed number of nines. The repository has provider quota
accounting, cached-data ages, error logging and regression tests, but not a
durable, independently sampled match-window reliability history. A healthy
quota endpoint or successful HTTP response does not prove current scores.

October 4: a bounded local API recorder and report command are implemented;
see `score-reliability-recorder.md`. They preserve planned checks, missing
observations and expected-fixture failures in an append-only ledger. This is
measurement tooling, not an installed continuous monitor or an achieved SLO.

The September 26 release `c6274e8` passed 1,563 JavaScript tests, Go tests,
production build and headless public mobile/desktop checks. Those checks saw
working PL/CL feeds and a labelled saved CL table. They did not measure a busy
matchday, source event latency or sustained availability.

## Targets and measurement

| Measure | Initial acceptance target | What counts |
| --- | --- | --- |
| Usable scoreboard availability | 99.95% | Independent browser journeys render the selected competition and usable scores or an accurate empty state within two seconds. A spinner, error page, missing expected fixture or malformed payload fails. A labelled saved score can pass availability but fails freshness when too old. |
| Collection freshness | 99.9% of expected active-fixture observations | A displayed score/status comes from a successful, validated provider observation no older than 60 seconds. Missing fixtures, missing timestamps, failed reads and stale fallbacks fail. A recent HTTP fetch alone cannot prove the provider's own data is current. |
| Change delivery | p95 <=30 seconds; p99 <=60 seconds | From first independently observed provider score/status change to the same version rendered in a foreground browser. Record reference sampling resolution; do not call this real-event latency. |
| Read latency | p95 <=500 ms | Public stored-data API reads from the initial audience region, including failures in the report. Report browser rendering separately. |
| Detection and failover | Alert within 60 seconds of a detected freshness breach; collector takeover <=30 seconds | Independent monitor, timed fault injection, no competing writer or duplicate budget after takeover. Last-good values remain available with truthful age; stale indication starts at 45 seconds. |

Evaluate each competition and each busy match window separately, as well as a
rolling 30-day view. Quiet overnight hours must not improve the match-window
score. Also report the worst individual fixture and longest continuous delay;
aggregate success must not hide one broken match.

The expected-fixture set comes from reconciled schedules and remains eligible
from scheduled kickoff through a confirmed terminal status, including halftime,
extra time and penalties. A missing match or stale scheduled status must not
remove it from the denominator. Postponements and cancellations require evidence.
Before/after kickoff schedule checks cover discovery failures.

Sample public API health every five seconds during match windows and run
headless browser journeys at least every 30 seconds. Retain collector events and
rendered version acknowledgements for finer change-delivery timing. Probe the
stored-data path; probes must not each trigger additional provider reads in the
replacement architecture. Count missing scheduled observations as unknown and
against acceptance; separately report monitor coverage. Do not interpolate a
short outage into a precise duration beyond the sampling resolution.

User-visible outages count even when the cause is the provider. Keep internal
collection, upstream data delay and display delay as separate diagnostic series.
To measure actual event delay, obtain trustworthy event timestamps or an
independent reference feed; a repeated 200 with an old score is not proof of
freshness. Do not infer inactivity just because a score has not changed.

For intuition only, eight hours of continuously measured availability allows:

| Success rate | Equivalent unavailable time |
| --- | ---: |
| 99% | 4 minutes 48 seconds |
| 99.9% | 28.8 seconds |
| 99.95% | 14.4 seconds |
| 99.99% | 2.88 seconds |

Fixture-observation percentages and request percentages have different
denominators; do not report this illustrative time conversion as measured
fixture downtime. Targets are intentionally demanding and must be revised
explicitly if evidence shows that the product or provider cannot sustain them.

## Required engineering work

1. Establish durable external measurements before changing hosting. Store
   competition/fixture identity, version, last validated observation, publication,
   browser-render time, latency, expected probe time and error reason. Prove an
   injected stall reaches the alert destination; configuration alone is not
   working alert delivery. Record current performance without claiming a baseline
   from a handful of successful requests.
2. Build the dedicated collector and stored-data read path in
   `live-score-architecture.md`. One account-wide budget covers every existing
   writer/reader that contacts the provider. Viewer growth must not increase
   provider traffic. Reserve capacity for score reads and recovery; shed optional
   detail/analysis before scores. Enforce provider cooldowns and retry bounds.
3. Price active and standby collectors in separate availability zones. Use a
   fenced lease and a tested takeover deadline; only the active collector polls.
   A stale holder must be unable to publish or continue unbudgeted provider work.
   Test task loss, network partition, lease-store failure and deployment overlap.
   Multi-region failover is a separate decision after measured need, not an
   assumed property of using AWS.
4. Evaluate provider freshness and availability across busy windows. API-Football
   supplies data without a guarantee under its published terms. A quota upgrade
   is not a data-quality SLA. If it cannot meet the target, evaluate a contracted
   primary service and an independent fallback source. Validate upstream
   independence, fixture identity, correction ordering, coverage, failback and
   actual latency before enabling failover. Never combine conflicting scores by
   simply choosing the largest number. Obtain concrete prices before purchase.
5. Load-test 1,000 concurrent readers initially and at least 10x observed peak
   once traffic is known. Replay the supported competitions' crowded schedules
   while injecting slow bodies, 429s, provider 5xx, successful-but-incomplete
   payloads, score corrections and collector loss. Provider call volume must
   remain bounded by the collection plan. Include cold-cache reads and deployment
   recovery; repeat the public headless journey after cutover.
6. Shadow-test at least two representative match windows before cutover, including
   crowded CL play, within a shared request budget. Require a 30-day measured
   report with at least three busy windows before describing a sustained service
   level. Publish sample counts, missing coverage and worst-window results; a
   clean short trial cannot establish four or five nines. An exhausted error
   budget pauses unrelated feature releases until reliability work restores it.

## Sources and limits

- [Google SRE: implementing SLOs](https://sre.google/workbook/implementing-slos/)
  distinguishes availability, freshness, correctness and coverage. The numerical
  targets above are our product decisions, not recommendations attributed to Google.
- [API-Football service and data terms](https://www.api-football.com/terms)
  do not guarantee data or its availability. A contractual service level, where
  offered by a provider, still does not promise zero outages.
- [GitHub scheduled workflow limitations](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
  include delayed and dropped runs. The GitHub feeder is an interim measure,
  not the timing foundation of the proposed reliability contract.
