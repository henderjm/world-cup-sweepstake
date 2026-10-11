# Busy matchday collection repair

The previous collector discarded embedded events, lineups and player statistics
from `/fixtures?ids=...`, then fetched them again. It also polled empty pre-match
events and statistics. Its fixed 4500-request detail cutoff froze Liverpool–Man
City at minute 11 despite remaining daily quota.

The repair retains validated embedded detail, refreshes it before standalone
cache deadlines, and uses the batch response for final fixture reconciliation.
Pre-match standalone events/statistics are skipped. Fixture and complete lineup
pre-match polling use 15 minutes; unpublished lineups use five minutes. Historical
validation failures back off for 15 minutes. Current detail (including player
statistics and the first 24 hours after kickoff) shares protected admission,
below due score jobs. Background work retains its 1500 total-use cutoff and all
requests retain the shared 7500 daily / 300 minute policy. No budget reset or
provider upgrade. A nonempty stale timeline now explicitly reports its age.

Provider contract: https://www.api-football.com/news/post/how-to-optimize-api-sports-calls-and-quota-usage
The documented ids response bundles up to 20 fixtures with available details.

## Accelerated full-day tests

`services/scores/test/busy-matchday.test.mjs` runs the production collector,
validation, publication, reader and quota state machines. Network and storage I/O
are replaced with deterministic adapters and virtual time. This is a workload
simulation, not a live traffic load test or an availability measurement.

- 24-hour day: 10 PL fixtures across five kickoff slots, 18 simultaneous CL
  fixtures, 60 archived fixtures and unavailable fantasy history creating
  background pressure. Periodic 503 responses, a three-minute provider outage,
  a collector restart, substitutions and final goals delayed by two minutes.
- 4585 provider requests: 3649 protected, 936 supplementary; 2915 daily headroom.
- All 28 final reader responses have complete fixture/events/lineups/player
  coverage, three goals and the substitution. Maximum final reconciliation
  delay 149 seconds, including the deliberate 120-second provider delay.
- Maximum live score source age outside the injected outage/recovery interval:
  44 seconds. Outage time is not claimed as available/fresh.
- Recovery run starts at 17:30 UTC with 4916 requests already used: another 1856
  requests, 6772 total, all 28 final details complete, maximum reconciliation
  148 seconds. Background requests remain blocked throughout this run.
- Separate real local DynamoDB tests verify embedded publication, final-whistle
  transitions, invalid embedded events preserving older detail and fresh scores,
  lease fencing, quota exhaustion and unknown statistics.

132 affected tests passed, including both simulations. Headless browser checks
and production rollout evidence are recorded after deployment.

These bounds apply to the tested PL/CL workload and failure patterns. Unlimited
provider outages, larger competition coverage and production traffic capacity
are not proven by this simulation.
