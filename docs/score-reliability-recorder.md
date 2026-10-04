# Recording a score reliability baseline

The recorder measures public API responses and their reported data ages. It does
not measure browser rendering or independently prove the provider's data is
current. Its reports must not be presented as achieved product SLOs.

Create an explicit plan for a match window (UTC instants, at most 24 hours):

```json
{
  "start": "2026-10-10T13:55:00Z",
  "end": "2026-10-10T17:30:00Z",
  "intervalMs": 60000,
  "origin": "https://goon-squad-data.gs-wc.workers.dev",
  "competitions": ["PL", "CL"],
  "fixtures": [],
  "fixtureReference": "Replace with a reconciled schedule and its observation time"
}
```

Populate `fixtures` with `{ "competition": "PL", "id": 123, "utcDate": "..." }`
using actual IDs and kickoff times from a checked schedule. Include ongoing
matches from before the window, as well as games due to start within it. An empty
list permits an API-only diagnostic and returns **null** for fixture freshness;
it does not certify an empty matchday. Freeze the list for the measurement window
so an outage or empty response cannot erase expected games. Record schedule
provenance in `fixtureReference`; the tool does not reconcile schedules for you.

```sh
node scripts/measure-score-reliability.mjs record /tmp/score-plan.json /tmp/score-observations.jsonl
node scripts/measure-score-reliability.mjs report /tmp/score-observations.jsonl
```

Use a new output filename for each run. The append-only ledger begins with the
plan and flushes each observation to disk. It deliberately refuses to overwrite
an existing log. Reports reconstruct every elapsed scheduled check from the
plan, so process loss, sleep or late startup does not improve the percentages.
An interrupted final append is ignored with a warning and remains missing;
malformed complete records and duplicate observations reject the report.

The recorder is a foreground command that exits after its bounded window. No
daemon, recurring schedule, infrastructure or alert destination is installed.
Move evidence out of `/tmp` to an approved durable location before relying on it
for a multi-day baseline. Laptop sleep and network loss count as missing or
failed observations; classify those separately when diagnosing an outage.

## Interpreting the report

- `monitorCoveragePercent`: completed observations / all elapsed planned checks.
  A completed timeout counts as observed, while a missed check does not.
- `usableApiPercent`: responses within two seconds with a usable shape and every
  expected fixture present with a usable status/score. Labelled old scores may
  pass this API measure while failing reported freshness. This is not the browser
  availability SLO, and it cannot verify a genuinely empty day without a schedule.
- `reportedFixtureFreshnessPercent`: expected fixture observations with a valid
  score/status and a feed-reported age of at most 60 seconds, without a stale
  flag. An unconfirmed kickoff, absent fixture, malformed score, missing timestamp
  or old snapshot fails. Up to one second of source clock skew is tolerated; the
  signed raw age remains in the ledger. Larger future timestamps fail.
- `feedReasons` records API/timestamp/missing-observation reasons even on idle
  days. `reasons` counts failures for expected fixtures. Each fixture also gets
  its own percentage and longest sequence of failed checks. This sequence is
  sample evidence, not a precise outage duration.
- Latency percentiles include completed errors and timeouts. Missing observations
  have no measured latency and are reported in coverage, not invented as a duration.

A probe more than `min(1 second, interval/10)` late, or finishing after the next
slot, cannot repair the expected observation. Expected fixtures remain in the
denominator from kickoff until a fresh validated terminal result; stale final
results cannot retire them. A subsequent fresh live correction reopens them.
The same upstream status can still be wrong: independent provider comparison
and publication/version timestamps remain required for the full SLO.

## Quota and failure testing

The existing Worker can fetch upstream on a public read. The recorder enforces a
minimum 60-second interval for that production hostname, issues no retries and
does not bypass caches. Requests per run are bounded by competition count times
scheduled slots. This is not a bound on upstream calls per Worker request.
Five-second probes are reserved for the future stored-data API or local replay.
Every request, including body consumption, has a deadline of `min(8 seconds,
interval)`. Credentials and full provider response bodies are not recorded.

```sh
node --test test/score-reliability.test.js
```

Tests include a real local HTTP recorder, interruption recovery, an actual stalled
body cancelled by fetch, wrong/missing fixtures, stale/future timestamps, clock
skew, corrections, halftime/extra time/penalties, competition isolation, missed
checks, empty denominators and prevention of fast polling of the current Worker.

Next: supply independently reconciled fixtures; integrate browser/version
observations; provision an independent always-running monitor after approval;
test delivery to an approved alert destination; then collect representative busy
windows. See `live-score-reliability.md` for the acceptance gates.
