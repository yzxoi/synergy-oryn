# Decision Record: Host-derived Oryn review requirements

Status: implemented

## Problem

The delivery gate required general review and domains that engineering had explicitly dispatched. Engineering could omit a specialist and deliver a candidate touching credentials, persistence, Channels or publishing with only general review. Checking only the latest repair diff would also omit risks introduced earlier in the same PR. Review fingerprints did not identify the Host review policy.

## Decision

The Host verifies the accepted code worktree and computes changed paths from the original Case baseline to the current frozen candidate. Deterministic path rules establish mandatory domains, including deleted paths; Git rename detection is disabled so moving a sensitive file preserves its old path in classification. Required domains also include review domains requested in any Attempt of the Case. Existing independent-review acceptance checks apply to each domain.

Engineering and review tools expose the required domains, cumulative baseline and policy version. Prompts require separate domain reviewers and allow requesting additional domains for semantic risks. An unavailable candidate blocks delivery while Case reads retain an explicit unavailable result.

Review Assignment and report fingerprints include the Host policy version. Old reviews remain audit history but cannot satisfy the current gate or resume as a current reviewer. A fresh key creates a new reviewer; no migration changes historical review claims. Confirmed remote receipts retain their historical meaning, and readiness notifications rerun the current gate.

## Alternatives considered

**Rely on engineering to select specialists.** This leaves a required delivery property dependent on a model choosing to apply it.

**Inspect only the active Attempt diff.** Repair baselines advance to earlier candidates, so this loses the very changes the PR still delivers.

**Backfill old policy fingerprints.** Rewriting a fingerprint would claim a review ran under rules that were absent when it was performed.

## Consequences

Host gate tests reproduce missing-domain delivery and require all specialist reviews before success. Other tests retain security requirements across an ordinary repair, detect a renamed sensitive path and verify that fresh review restores eligibility after legacy fingerprints fail.

Path rules are a minimum rather than a semantic risk detector. Changes to the classifier require a policy-version bump and new reviews for in-flight candidates. Cumulative diff inspection requires the original Git objects and assigned worktree to remain available; failures block delivery. Already-ready or unresolved publications across a policy upgrade still need operator reconciliation.
