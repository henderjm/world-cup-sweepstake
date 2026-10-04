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

For the approved stored service, propose one PL and one CL probe every 15 seconds.
A 30-day month adds 345,600 API requests, before any browser journeys or watchdog
traffic. At the current 200 KiB response assumption, that is 65.92 GiB of outbound
AWS data, costing $5.93 in transfer alone without free allowances. The cost calculator now adds these
requests to each visitor-traffic scenario; do not add them a second time. The existing provider-backed Worker remains protected by
its 60-second sampling minimum until stored mode is approved and verified.

Record missing slots, HTTP failure, slow responses, worst active-fixture source
age, and fixture completeness against a separately verified schedule inventory.
A 200 response and recently collected timestamp do not prove the provider has
reported every on-field change. Keep provider-visible-to-screen measurement and
headless browser usability checks separate from API observation freshness.

The current scripts accept plans of at most 24 hours. Recording opens a new
ledger exclusively, and the watcher rereads a ledger capped at 64 MiB. They do
not yet supply unattended window rollover, bounded historical retention or a
safe resume coordinator. A systemd Restart=always wrapper alone is insufficient:
it can collide with an existing evidence file or stale lock. Implement a durable
supervisor that resumes the same planned window, preserves missing slots and
pending alerts, and starts the next window without silently dropping coverage.
Benchmark its disk, memory and CPU before selecting the VM size. Preserve at
least 30 days and three busy windows for the reliability report.

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
