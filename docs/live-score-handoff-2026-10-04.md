# End-of-day handoff — 4 October 2026

## AWS cutover completed after later owner approval

The later AWS instruction superseded the initial wrap-up below. Production score
reads now use the Ireland AWS stack; frontend c488c35 is deployed, service
artifacts are bb79bf0, and Worker version 8c76a000-759e-48ce-95ee-1241879d06f2
uses the AWS origin with its provider key removed. Both ECS services target one
task in separate AZs. The standby acquired epoch 6 within 15.916 seconds during
a controlled stop; all twelve sampled public league reads succeeded.

Release branch `codex/aws-cutover-release` and main contain the reviewed work.
The primary checkout still contains unrelated mobile/native changes: preserve
them. Headless production journeys passed at 390px and 1440px: upcoming dates, both
league tables, completed-match timeline/lineups, no browser errors or overflow.
The paced manual export passed in run 37219360105. The shared budget reached
1500 used, preserving 6000 requests for scores; supplementary work is deferred.
Provider squad conflicts are explicitly excluded; supplementary history
and detail coverage remain incomplete. The provider plan was not upgraded.
Independent monitoring/paging and busy-day SLO evidence remain the first backlog
items. Hourly automation remains PAUSED. See the cutover JSON and current backlog
for exact resources, revisions, evidence and limitations.

## Earlier wrap-up before AWS authorization


Stopped at the user's request to conserve usage. Continue from branch
`codex/live-score-quality`; implementation HEAD is `5594472`. Work is committed
locally, but this branch has no upstream and no locally known remote branch
contains HEAD. No new infrastructure, spending or deployment was performed.
Hourly automation `improve-live-scores` is confirmed PAUSED.

## Completed and verified

- Matchday discovery shortcut, CL interim shared ranks, and full-width standings
  without a duplicate sidebar. Scores retains standings on wide screens.
  Headless journeys covered mobile and desktop, including 390/900/1200/1440px
  for the last layout change (`14a95c0`).
- AWS target is the user's existing account `134471064301`, Ireland. Infrastructure
  remains unapplied. Account/network preflight and declared IAM simulations passed;
  actual deployed permissions, egress and failover are still unverified.
- Service artifacts rebuilt from `2b9f362`: 80 tests passed inside the non-root,
  read-only Linux image with disposable DynamoDB. ZIP import checked. Manifest:
  `live-score-evidence/2026-10-04-release-2b9f362.json`. Not uploaded.
- Integrated application suite previously passed 1,678 tests in the current
  worktree, including separate native edits. This preceded the later layout and
  monitor changes and is not an exact-HEAD or deployed-release claim.
- Monitor state cleanup now survives real ENOSPC; recorder guards against early
  timer wake-up. Final focused suite after that change: 33 passed (`7372c8d`).
- Actual recorder partial-write recovery verified on a 64 KiB disposable tmpfs:
  preserved two complete observations, discarded 2,406 incomplete bytes, resumed
  to eight records and retained missing slots as 66.67% PL/CL synthetic coverage.
  Both disk tests and four Python-wrapper recovery tests passed (`5594472`).
- Trial pricing now uses the contracted five-second stored-API cadence rather
  than fifteen seconds (`55e29e4`). Scenario AWS subtotals are $64.88/$86.96/$307.71
  per month for 100k/1m/10m visitor requests plus monitoring. Existing October 4
  rate snapshot; these exclude browser checks, external monitoring/paging and
  provider subscription and are not a complete budget.

## Resume priorities

1. Finish independent monitoring: bounded evidence retention/replication,
   external process supervision, monitor-loss watchdog and approved human paging.
   Preserve missing slots and pending alerts. No unsolicited alerts to people.
2. Price the remaining browser checks, watchdog, receiver and provider allowance;
   assemble one concrete AWS trial approval with operator, window and rollback.
   Ask before spending or deploying. Do not infer permission from account selection.
3. After approval, verify actual AWS roles/egress and collector takeover, then
   capture busy-matchday evidence. Production availability nines remain unknown.
4. Resume product/competitor work from `live-score-backlog.md`, including remaining
   CL provider ordering discrepancies. No new leagues. All browser work headless.

One schedule integration run emitted four accepted incidents rather than two.
Subsequent repetitions, including six isolated pre-fix runs, passed. Root cause
is unconfirmed; keep timestamp/event diagnostics and investigate recurrence.
Do not label it conclusively fixed or relax the acceptance threshold.

## Workspace and shutdown

Unrelated native/mobile changes remain unstaged across application, package and
platform files; preserve them. Do not stage the whole worktree. No owned test
server or disposable test container remains running. Other existing Docker
services were left alone. Kanban:
https://chatgpt.com/space/page_6ac22fa3f7a08191811317ab2199240e

Resume the ongoing goal only when the user asks; do not restart hourly automation
without authorization. The goal is paused for the day, not completed.
