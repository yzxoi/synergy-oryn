# Decision Record: Oryn verified-memory learning with gated promotion and withdrawal

Status: implemented

## Problem

Cases accumulate reusable engineering knowledge, but automatically writing every lesson into shared memory would pollute the Library with unverified claims, leak private conversation content, and leave wrong lessons in place after they are contradicted. Two constraints from the product proposal bound the design: only traceable, evidence-backed outcomes may become shared knowledge, and automatic Experience rewards stay off until the upstream reward API provides event idempotency. The pipeline needed a learning path where a model can propose a lesson, but only the host can promote it, only after the case actually delivered, and a wrong lesson can be removed precisely.

## Decision

Lessons enter through `oryn_learn` (`OrynLearning.propose`) as candidates in the `oryn/learning/` storage prefix, never directly into memory. Every proposal must cite evidence refs that the host validates against real records of the same case (run receipts, review reports, worker reports, attempts); a ref that resolves to nothing is rejected as `EVIDENCE_INSUFFICIENT`. Each candidate carries its own applicability scope, an invalidation condition ("when this stops being true"), the outcome version it was verified at, and only case-scoped record ids — raw chat text, private logs, and credentials have no path into the candidate. Duplicate proposals of an identical lesson dedupe.

Promotion (`OrynLearning.promoteCase`) is host-side and double-gated: the case must have a delivered (`ready`) attempt, and the deployment must have explicitly enabled `oryn.learning.verifiedMemory` (default `false`). The oryn domain never imports the Library; product assembly injects a `MemoryPromoter` port, so promotion writes through the same `LibraryDB.Memory` path as `memory_write`, one self-contained entry per lesson with the invalidation condition and evidence refs in the body. Deliberately no semantic dedup at promotion: each lesson is independent, so withdrawal removes exactly the entry it created and never a pre-existing unrelated memory. A merged-but-unreleased fix cannot read as generally available because the entry states the outcome version it was verified at.

Withdrawal (`OrynLearning.invalidate`) flips the candidate to `rejected` and removes the promoted shared memory through the same port; the candidate record stays for audit. Reward automation (`oryn.learning.autoReward`) is declared in config but intentionally unimplemented pending upstream idempotency.

## Alternatives considered

**Let workers write shared memory directly.** Rejected: it collapses the propose/promote boundary, leaks whatever the worker saw into a shared surface, and leaves no audit trail of who claimed what from which evidence.

**Semantic dedup at promotion.** Rejected for this path: similarity-based dedup could merge a new lesson into an older, differently-scoped memory, and withdrawal would then either delete shared knowledge it did not create or leave the merged entry half-valid. Per-lesson entries keep promotion and withdrawal exactly inverse.

**Wait for the reward API and ship learning + rewards together.** Rejected: lessons and rewards are separable; withholding verified-memory promotion until the reward API is idempotent would block a useful, safely-gated capability behind an unrelated upstream gap. `autoReward` stays a declared no-op instead.

## Consequences

Wrong lessons are recoverable but not self-healing: withdrawal is an explicit act by the engineering session, so a contradicted lesson lingers until someone withdraws it — the invalidation condition in every entry is what makes that review practical. Because promotion is off by default, a fresh deployment gains nothing from learning until an operator opts in, which keeps the dormant-domain invariant. The LearningCandidate records are global (not per-scope), so a future cross-project recall path can filter by the applicability scope recorded on each entry.
