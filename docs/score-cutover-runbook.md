# Score-service cutover and rollback

Preparation only. Account: `134471064301`; AWS region: `eu-west-1`.
Repository: `henderjm/world-cup-sweepstake`. No commands below authorize spending,
public deployment, changing provider credentials or stopping production jobs.
Obtain approval for the exact revisions, operator, window and priced resource plan.
Retain command results with UTC timestamps and exact deployed versions.

## Source-selection invariant

Repository variable `SCORE_READ_ORIGIN` is the shared desired source:

- Pages score/detail/scorer and fantasy-player exports read the stored API.
- The legacy detail-feeder job is gated off when the variable is nonempty.
- Worker CI passes the same variable through `scripts/deploy-score-worker.mjs`.

Changing the variable alone does not update a running Worker or stop an already
running Actions job. Queued jobs may also have resolved their configuration.
A Worker deployment must be explicitly dispatched and verified. A green workflow
with the deploy token missing is a skip, not evidence of a deployed binding.

Use `SCORE_READ_ORIGIN=https://<approved-reader-host> node scripts/deploy-score-worker.mjs`
to preview the command. `--dry-run` bundles it without publishing. `--deploy` is
only for the approved deployment step. The helper passes arguments without a
shell and explicitly supplies the binding even when empty for legacy rollback.
Reject URLs with credentials, paths, query strings or non-HTTPS schemes.

## Before collection starts

1. Record frontend/Worker release revisions, active Worker version and bindings,
   repository variable values, workflow enabled states, all in-flight workflow
   run IDs, provider usage and every independently configured provider consumer.
   Do not print secret values. Confirm the operator can restore credentials from
   the approved secret store; removing a key without a restoration path is unsafe.
2. Apply only the approved infrastructure with `EnableCollection=false`. Resolve
   physical resource IDs from that exact stack. Verify both ECS services have
   desired/running/pending counts of zero. Verify the actual role allow/deny tests
   and reader unavailable responses before supplying provider authority.
3. Disable new runs of `pages.yml`, `live-detail-feeder.yml` and
   `deploy-worker.yml` during the coordinated change window. Cancel and then
   verify termination of all queued/running instances, including self-dispatched
   feeder successors. Also stop ad-hoc scripts and any external consumer found
   in the census. Preserve the previous enabled states for later restoration.
4. In the approved public maintenance window, deploy the prepared stored-mode
   Worker with the approved origin and remove its provider key. An empty stored
   service may temporarily make scores unavailable; use an explicitly approved
   independent provider allowance instead if that interruption is unacceptable.
   Never make an unbudgeted shadow collector to hide this transition.
5. Verify the running Worker version/binding and cessation of upstream calls;
   setting an environment variable or deleting a secret is not that proof.
   Wait for old in-flight requests to settle and account conservatively for
   uncertain requests. Record all consumers stopped before measuring usage.
6. Read current provider usage/limits through an approved operator channel and
   prepare initialization evidence per `infra/scores/README.md`. Preview with
   `node services/scores/run-initialize-budget.mjs EVIDENCE.json`; then use
   `--apply` only after approval. Evidence must be <=5 minutes old, same UTC day,
   outside the last 30 seconds before reset. Do not retry an uncertain write by
   resetting the budget: inspect its persisted outcome first.
7. Enable collection on the approved stack. Verify lease ownership, a complete
   PL/CL score/detail publication, PL fantasy data, freshness and quota movement.
   Exercise takeover and old-writer fencing before calling the trial successful.
8. Set the repository source variable to the same approved reader origin. Restore
   approved workflow states; verify that the feeder is skipped and that Pages
   exports do not call the provider. Verify a Worker deployment retains the
   source binding. Compare the actual Worker/frontend revisions, not job colour.
9. Run the full public journey and side-effect gates from `aws-score-trial.md`,
   including sign-in, follows, match detail, predictions, fantasy scoring and
   approved notification receipt. Observe independent monitor incident/recovery
   and retain missing observations. A healthy API alone does not pass this gate.

## Rollback ordering

1. Freeze new workflow runs and verify existing relevant jobs terminal again.
2. Stop both new collector services through the approved stack change. Confirm
   desired/running/pending task counts zero and actual provider traffic stopped.
   Preserve DynamoDB scores, lease, consumed budget and observation evidence.
3. Confirm the provider's remaining allowance can support the legacy consumers.
   Do not assume restoring the old code restores quota already consumed.
4. With new collectors stopped, restore the approved previous Worker revision and
   required provider credential. Explicitly clear `SCORE_READ_ORIGIN` in the
   Worker deployment and repository variable as one coordinated rollback.
   Verify actual Worker bindings/version before re-enabling legacy workflows.
5. Restore only the previously enabled workflows. Verify no dual consumer path,
   correct PL/CL freshness, match details and fantasy side effects. Record the
   rollback outcome; returning to the legacy system restores its known limits.

## Still required for execution

The approved stack name/physical IDs, immutable image and reader artifacts,
operator, maintenance timing/settling interval, independent monitoring/paging,
complete costs, provider allowance and runtime inventory are not filled in yet.
Do not substitute guessed IDs or consider this draft deployment approval.
