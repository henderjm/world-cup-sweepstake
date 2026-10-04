# AWS score-service trial

Draft, 4 October 2026. PL and CL only. Local candidate: `cf5787c` plus subsequent
repository documentation. No AWS resources, subscription changes or deployment
are authorized by this document. Do not request spending approval until the
infrastructure plan, full estimate and operating gates below are reviewable.

## Deployment decision

Use two on-demand Linux/x86 Fargate collectors, one per availability zone in
Ireland, initially 0.25 vCPU and 0.5 GiB each. This is a sizing assumption to load
test, not measured capacity. Both run the same image and share the existing
DynamoDB lease/budget; only the lease holder calls the provider. Avoid Spot for
this initial recovery trial. Separate single-task services constrained to their
respective subnets make placement explicit. A replacement must not gain write
or provider authority until it wins the lease.

Use one regional on-demand DynamoDB table and a Lambda/HTTP API stored-read
service. The reader gets GetItem only, restricted to SCORE, DETAIL and FANTASY
key prefixes. It gets no write actions, budget/lease access or provider secret.
The collector application gets only the table operations used by the adapter.
The separate ECS execution role reads its provider secret and injects it at
startup; the reader gets neither that role nor the secret.
No long-lived AWS keys go into GitHub or containers. The existing Cloudflare
Worker retains authentication, D1, fantasy mutations, analysis and notifications.
This is a regional design, not regional-disaster failover.

Trial collectors can use public-address subnets with no inbound rules and
outbound HTTPS, avoiding a NAT gateway baseline. Security groups cannot constrain
HTTPS destinations by hostname. Strict provider-destination enforcement would
require additional egress controls and their cost; do not claim an HTTPS rule is
a domain allowlist. Verify the provider accepts the actual AWS egress route.
Resolve this network choice in the infrastructure plan before approval.

## Verified price inputs and unmeasured quantities

`costs/aws-ireland-rates.json` preserves seven official AWS Ireland rate records,
SKUs, catalog versions and source URLs, retrieved on 4 October 2026 using the
[public price-list mechanism](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-the-aws-price-list-bulk-api-fetching-price-list-files-manually.html).
The [Fargate pricing page](https://aws.amazon.com/fargate/pricing/) describes CPU,
memory and additional network/log charges; the regional catalog supplies the
actual rates used here. Two proposed collectors cost $18.02 per 730-hour month
for CPU and memory alone.

Run `node scripts/estimate-score-trial.mjs` to reproduce
`costs/aws-trial-scenarios.json`. These are USD subtotals, not complete estimates:

| Monthly stored API requests | Assumed response transfer | Compute/API/database subtotal |
| --- | --- | --- |
| 100,000 | 19.07 GiB | $27.17 |
| 1,000,000 | 190.73 GiB | $33.29 |
| 10,000,000 | 1,907.35 GiB | $94.54 |

Assumptions: 200 KiB transferred per response, 0.5 GiB Lambda memory, 150 ms per
request, 30 DynamoDB read units per API request, and 10 million collector read
units plus 10 million write units per month. They are not observed traffic,
capacity or billing. DynamoDB transactional writes consume more units than
ordinary writes; the assumed write-unit count must already include that effect.
Cold partitions, concurrent Lambda instances, collector loop frequency and
changed-part sizes must be measured before replacing these placeholders.

Excluded costs remain explicit in the generated report: internet transfer,
public IPv4/NAT, logs/metrics/alarms, independent monitor/paging, secrets, image
registry/build storage, table storage/backups, provider subscription, tax/support
and existing Cloudflare costs. No free-tier credits or discounts are assumed.
At the larger scenario, network transfer can materially change the result. Do
not quote the subtotal as the monthly budget or approve a trial from it.

## Cutover sequence to prove in staging

1. Build immutable collector and reader artifacts from one recorded revision.
   Produce infrastructure, IAM and rollback plans without applying them.
2. After explicit approval, create the isolated trial resources and initialize
   the budget from verified provider usage and limits. Initialization fails
   closed; never assume zero usage or reset a consumed allowance.
3. Avoid parallel unbudgeted use of the same provider account. Trial collection
   needs an isolated approved allowance/key or an explicit migration window that
   stops the old consumers. Merely adding a shadow collector is unsafe.
4. Collect complete PL/CL score/detail and PL fantasy datasets. Exercise a task
   crash, paused task, old-writer delay, provider timeout/429, budget exhaustion,
   malformed page and reader failure. Read-only load must not increase provider
   demand. Save exact revisions, timestamps and result evidence.
5. Stage the Worker with SCORE_READ_ORIGIN and no provider key. Set the matching
   GitHub variable only in the approved cutover sequence: it switches both bakes
   and disables the feeder. Confirm no in-flight legacy Actions job remains;
   a variable change does not cancel an already-running process.
6. Verify routes, sign-in, fixture locks, scores, details, predictions, live/final
   fantasy scoring, xP, waivers and actual approved notification delivery. Local
   fixtures cover some of these, not all real cloud side effects.
7. Switch public traffic only after approval and these gates. Retain dated
   evidence of the exact Worker, collector, reader and frontend revisions.

Rollback must first stop the new collectors and verify cessation of provider
calls before restoring old consumers and credentials. Restore the prior Worker
and GitHub configuration as one coordinated operation. Keep stored datasets and
D1 state; do not erase evidence or reverse settled points blindly. A return to
the legacy architecture restores its known limitations and is not a reliability
success. Define the operator, commands and observation interval in the final
runbook before deploying.

## Acceptance and remaining preparation

Use the existing reliability contract: 99.95% usable browser availability,
99.9% active freshness, p95 provider-visible-to-screen delay at most 30 seconds,
p99 at most 60 seconds, stale indication at 45 seconds and takeover within
30 seconds. Targets remain unachieved until measured. Require 30 days including
three busy windows before sustained reliability claims.

An independent monitor outside the score-service failure domain must record
PL/CL worst-fixture freshness and missing probes, verify incident/recovery
receipt at the approved paging destination, and keep evidence across restarts.
A CloudWatch alarm alone does not prove that a stale HTTP 200 reached a human.

Still required before asking to spend: runnable infrastructure and immutable
artifacts; a full region-specific cost model including network and monitoring;
read-volume/partition/loop measurements; API limits and real egress validation
plan; IAM denial tests; an exact budget-preserving cutover/rollback runbook; and
an approved operator/paging destination. This draft closes the unsupported
compute-price assumption, not the whole deployment package.

Infrastructure draft: `../infra/scores/trial.json` now declares the regional
resources and roles with collectors defaulting off. Schema and local policy
checks passed; cloud IAM, capacity and failover remain unverified. See the
adjacent infrastructure README for inputs and remaining approval gates.
