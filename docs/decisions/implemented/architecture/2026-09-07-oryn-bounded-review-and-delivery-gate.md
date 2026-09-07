# Decision Record: Oryn bounded review, rework rotation, and the fail-closed delivery gate

Status: implemented

## Problem

Automated fix delivery needs an independent quality gate that does not trust the authoring session. A model that wrote the candidate cannot also be the one that declares it correct: it could clear its own findings, loop on a failing candidate forever, or mark work ready on evidence that no longer matches the delivered head. The pipeline needed three deterministic guarantees: reviewer identity and findings cannot be forged by the author, autonomous rework is bounded so failures hand off to a human instead of churning, and nothing reaches `mark_ready` unless every precondition is still true at delivery time.

## Decision

Review intake (`OrynService.submitReview`) is open only to the review assignment's session; the host pins the review head to the attempt's frozen `candidateSha` and the base to the attempt baseline, so a review cannot silently attach to moved code. Findings are append-only across review rounds with an explicit-disposition continuity rule: an open finding must be carried forward or explicitly disposed — it can never silently disappear between reviews. Each report records a digest of the accepted acceptance criteria and of the evidence run ids it relied on.

Rework (`oryn_dispatch` action `rework` → `OrynStore.rotateAttempt`) supersedes the current attempt under the case lock and opens the next attempt pinned to the previous candidate, so the PR history stays fast-forward. The host enforces the configured repair-round cap (default 3) and no-progress cap (default 2, detected by an unchanged candidate SHA across rotations); hitting either cap hands the case to a human deterministically via `human_owned` and an epoch bump. Case-level budgets (wall clock, heavy runs) are never reset by a new attempt.

The delivery gate (`OrynService.evaluateDelivery`) is a seven-step deterministic check that fails closed: control state must be `active`, the attempt must have a frozen candidate in `candidate_frozen`, bug cases require a failing baseline run receipt, delivery requires a clean (non-overlay) passing candidate run at the exact frozen SHA with no unresolved inconclusive or cancelled runs, the latest review for the candidate must recommend `ready_for_human` with no open P0/P1 blockers and no unresolved design decisions, CI status must be observed (unknown counts as failure), and the delivery payload must reference the frozen candidate and contain no secrets, internal session/case ids, or absolute home paths.

## Alternatives considered

**Let the engineering session grade its own work.** Rejected: the whole point of the independent reviewer session is that the author cannot both produce and certify a candidate; every known failure mode of self-review showed up in the design review of this proposal.

**Unbounded rework with an LLM judgment of "progress".** Rejected: a model judging its own progress is exactly the forgery surface the cap exists to close. The no-progress cap compares candidate SHAs — a deterministic signal — instead of asking a model whether this round felt different.

**Run the delivery gate once at review time.** Rejected: state between review and delivery (CI, control takeover, acceptance amendment) changes asynchronously; the gate is cheap and deterministic, so it re-runs at every `mark_ready` against current state.

## Consequences

A stale report is stored for audit but never advances the candidate, so an epoch bump (takeover, handoff) instantly invalidates in-flight judgments. Overlay-flagged runs can never satisfy the "clean candidate pass" requirement, so an experiment patch cannot masquerade as the delivered fix. The gate's payload checks are intentionally shallow (pattern-based); they are a hygiene net, not a security boundary — the real boundary is that the publish transport holds the credentials and the ledger records every external write.
