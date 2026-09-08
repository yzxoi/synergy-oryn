# Decision Record: Bind learning proposals to accepted Host evidence

Status: implemented

## Problem

Case membership alone allowed references to stale Attempts and unaccepted worker reports. The model-controlled outcome version was rendered as a verified version. Rewriting that memory template without preserving its old bytes would break identity/content verification during historical withdrawal and lost-acknowledgment recovery.

## Decision

The Host records each proposal's repository, Attempt, ownership epoch, acceptance digest, baseline/candidate commits and a digest of the referenced accepted records. References must belong to the active Attempt. Worker reports must be accepted by their current assignments; cited runs must come from their validated plans, match the assigned source, have a completed test outcome and recorded runtime or live-test provenance, and be attached to the Attempt. Infrastructure and synthetic observations cannot establish automatic learning provenance. Review references must be the current accepted ready report for their domain with matching source and policy/evidence digests.

Identical source and memory payload reuse the proposal identity. Changed source, evidence, applicability or invalidation creates a distinct proposal. Promotion requires the captured candidate and source to remain current, before preparation and again under the final Case lock. A pre-freeze proposal or one tied to replaced evidence cannot inherit a later candidate's delivery.

Learning schema version 2 stores the immutable memory title/content separately from mutable withdrawal status. New content states the Host source facts and labels the lesson and applicability as model proposals. The model cannot supply a verified version. The Library write/removal path uses the persisted payload, preserving byte-level replay and withdrawal after rendering changes.

The domain migration registered through the central runner converts version 1 records without inventing Host provenance. It materializes the historical writer's exact memory text, preserves IDs, timestamps, promotion state and acknowledged memory references, and leaves source absent. Legacy empty reference arrays emitted by the old unchecked writer remain representable. Missing provenance prevents automatic promotion, while the same stored payload remains usable for reconciliation and withdrawal.

## Alternatives considered

**Infer old provenance from the current Case.** A Case can contain several Attempts, and current delivery cannot establish when or from which evidence an old lesson was derived.

**Regenerate memory text during withdrawal.** Rendering changes and appended invalidation reasons would change the expected Library content, preventing reliable removal of historical or unacknowledged entries.

## Consequences

The learning domain rejects stale or unaccepted references, preserves source through restart, and checks evidence corrections that occur during preparation. Migration and Library tests cover old text/identity preservation, fresh state and repeated migration through the central runner. Existing unacknowledged random memory IDs from older binaries still require operator reconciliation because no durable reference identifies them.

Provenance proves which accepted evidence the proposal references, not that the text follows logically from it or contains no private material. Automatic memory remains opt-in and should stay disabled pending deployment-specific content review and safe embedding configuration. A ready PR is not a merged or released fix; the memory states that limitation explicitly.
