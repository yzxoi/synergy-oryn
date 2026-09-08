# Decision Record: Recover Oryn learning writes with a stable memory identity

Status: implemented

## Problem

Library insertion and Oryn learning acknowledgment use different stores. If insertion succeeds but its acknowledgment is lost, retrying with a fresh memory ID creates a duplicate and withdrawal cannot find the unacknowledged row. Concurrent proposals can also allocate separate learning IDs before either write becomes visible.

## Decision

The Host derives a namespaced memory ID from the durable learning candidate ID before calling the Library port. An acknowledged historical `memoryRef` remains authoritative. The Library port reuses an existing row only when title, content, category and recall mode match; conflicting content requires reconciliation and is neither overwritten nor deleted. Fresh insertion still uses the configured embedding transport and the ordinary Library database.

Proposal deduplication holds one Case-scoped lock across lookup and creation. Promotion and withdrawal share a candidate-scoped effect lock and reread the candidate after acquiring it. Withdrawal checks the deterministic ID even when promotion was not acknowledged, then records rejection only after removal is confirmed. An unavailable writer leaves withdrawal retryable. Library operations also serialize by memory ID, so concurrent replay does not duplicate embedding or insertion.

## Alternatives considered

**Record the ID only after insertion.** A crash between stores still loses the identity required for reconciliation.

**Deduplicate by similar text.** Similar lessons can have different evidence and applicability. Deleting a semantically matched memory could remove another lesson's knowledge.

**Treat missing removal support as successful withdrawal.** This would mark a lesson rejected while leaving it available to recall.

## Consequences

The persisted learning schema and storage layout remain unchanged: IDs are derived from existing immutable candidate IDs, and acknowledged historical IDs are retained. An old binary's unacknowledged random-ID insertion cannot be reconstructed from these records; operators must reconcile those historical orphan rows before enabling learning after upgrade. This is not a migration that invents missing provenance.

Behavioral tests reproduce lost acknowledgments and concurrent duplicate proposals, verify withdrawal and retry, and exercise the real Library database plus loopback embedding transport. Locks coordinate one runtime; separate processes must not share a writable runtime home. This change establishes write identity and cleanup, not the semantic validity of a lesson or completeness of its delivery evidence. The [learning policy](../architecture/2026-09-07-oryn-verified-memory-learning.md) remains separately enforced and audited.
