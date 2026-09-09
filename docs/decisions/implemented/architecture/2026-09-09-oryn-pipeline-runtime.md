# Decision Record: Run Oryn work against fixed versions and step budgets

Status: implemented

## Problem

Case-age deadlines expire queued work before execution. Comparing a PR head directly with a moving target includes unrelated target changes. A shared dependency snapshot becomes incompatible when contributor lockfiles change. Completed rollout records can prevent an unfinished assignment from resuming. Repeated review and environment messages make the operator channel noisy without improving delivery evidence.

## Decision

Use the existing Synergy Session, Boss assignment, ownership and publication machinery. No separate coordinator or scheduler service is introduced. Engineering owns workflow progression; repro establishes a behavioral failure, code owns changes and conflict resolution, verify executes fixed-commit checks, and independent reviewers submit structured reports. GitHub review-only work starts with general review and adds specialists for concrete risk; delivered fixes retain the stricter path-based domain requirements. All merges remain human-controlled.

The installation limit is `maxStepMinutes`, default 360. An execution ledger records cumulative time per Attempt budget identity, stage and review domain. Model/tool admission and actual background process lifetime acquire metering leases; overlapping activity in one step counts once. Idle gaps and restart downtime are excluded. Checkpoints occur every 15 seconds and final release persists elapsed time. Ownership resume carries the previous budget identity, while a new repair round has its own steps and remains subject to repair/no-progress limits. Migration replaces the old age-based setting without inventing past execution time. This supersedes the [archived Case-age policy](../../archived/bug-fix/2026-09-08-oryn-case-wall-clock-budget.md).

PR input records distinguish head, target base and merge base. Host fetch retains fixed objects, and changed-file classification and review use merge-base-to-head scope. Target-only advancement does not invalidate an otherwise unchanged review. Baseline and candidate checks each materialize the requested commit into an independent experiment; caller HEAD and uncommitted worker edits do not select its source. An explicit bounded test-only patch can be applied to both versions, and the receipt includes the resulting tree digest.

Trusted-local profiles can perform frozen-lock dependency installation in each experiment. Bun, pnpm, npm and Yarn are detected; installation requires an allowlisted package manager and unambiguous committed lock. Only download caches are reused. Sealed dependency snapshots remain an explicit offline/contained option. Dependency setup errors remain environment failures. The Host rejects installers that change tracked inputs.

Review publication updates a durable App comment identified by repository/PR and review revision markers. It includes the exact reviewed head, evidence, questions, limitations and bounded prior review history. Lost responses reconcile by the exact revision marker. Findings or questions transition to `waiting_author` and release active capacity. PR authors can request re-review; only repository writers can authorize repair or stop work. Repair can append to a same-repository contributor branch with expected-head comparison and ancestry validation. An inaccessible fork receives a credited continuation PR. No contributor history is rewritten.

Before delivery, the Host fetches the live target and inspects mergeability without rebasing a compatible candidate. When conflicts exist, a code assignment starts a Host-owned merge in its clean worktree, resolves semantics, and commits through the Host with both parents preserved. Preparation is recoverable, abortable and refuses repository-configured merge/filter drivers. Conflict markers block commit. A changed candidate must pass independent verification and review again. Human merge and repository CI remain the final integration decision.

Terminal rollouts without accepted reports receive a fresh task root in the same Session/worktree; interrupted rollouts retain normal steering. Recovery remains bounded. Oryn avoids generic file snapshots and optional activity-summary inference because fixed Git versions and durable workflow records supply its evidence. Equal environment failures in a repository can share one operator notification; source-specific clarification remains separate. Nonactive open work continues to receive accurate label projections.

## Alternatives considered

**Increase the Case-age deadline alone.** It still charges queues, pauses and downtime and does not identify which work consumed the allowance.

**Reuse one provisioned source and dependency tree.** This conflates different PR versions and lockfiles. Fixed objects and isolated experiment installations preserve attributable evidence; offline snapshots remain available when installation is unsuitable.

**Rebase every PR whenever the target advances.** This causes unnecessary conflict work and invalidates useful review. Detect actual conflicts separately and preserve contributor history with expected-head checks.

**Automatically fix every external finding.** Review permission is not branch-edit permission. Author iteration is the default, and privileged repair is explicit.

**Introduce another coordinator.** Existing Session/Boss concurrency and durable domain state already own execution and recovery. Additional scheduling would duplicate ownership decisions.

## Consequences

Settings expose step minutes and active task capacity. Tests cover different baseline/candidate checkouts, frozen dependency installation, explicit test overlays, real conflict preparation and two-parent commit recovery, adoption of existing PRs, cumulative metering, terminal rollout recovery, migration and actual grouped notification delivery. Native process and end-to-end pipeline tests remain necessary alongside these domain tests.

Execution budgets measure active elapsed time, not CPU or tokens; an abrupt crash can lose the last uncheckpointed interval. Disposable check outputs are still removed after completion, and immutable object/cache garbage collection is not introduced here. Mergeability inspection does not claim that every possible merged tree has passed runtime tests. Delivery receipts continue to describe the tested candidate and CI facts; humans approve merge.

## References

[OpenClaw review](https://github.com/openclaw/openclaw/blob/main/scripts/pr-lib/review.sh) and [prepare](https://github.com/openclaw/openclaw/blob/main/scripts/pr-lib/prepare-core.sh) informed the separation of review from integration. [Clawsweeper target dispatch](https://github.com/openclaw/clawsweeper/blob/main/docs/target-dispatcher.md), [review comments](https://github.com/openclaw/clawsweeper/blob/main/docs/pr-review-comments.md) and [repair updates](https://github.com/openclaw/clawsweeper/blob/main/docs/repair/auto-update-prs.md) informed durable review comments, author iteration and explicit repair. These workflows are adapted to Oryn's existing Host authority and installation constraints; they are not runtime dependencies.
