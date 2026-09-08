# Decision Record: Require current delivery before promoting Oryn learning

Status: implemented

## Problem

The learning promotion loop searched all Attempts for a ready disposition. That was insufficient to prove that the active Case still owned a delivered candidate, that its publication had been acknowledged, or that the remote PR and CI still matched. Preparation also left time for ownership or policy to change before the Library insertion.

## Decision

Promotion reuses the same ready projection and remote verifier as delivery notifications. The projection binds the active Case, current Attempt, acknowledged mark-ready action, repository configuration and installation policy. The verifier observes the PR identity, branch, head, draft/open state and CI, then reevaluates delivery evidence. Missing or stale proof prevents promotion.

The Library port prepares embeddings without holding the Case lock and exposes its synchronous database write through a Host commit callback. The Host confirms remote delivery again after preparation, acquires the Case lock, compares the full current projection with the captured proof, and only then inserts the memory and records its acknowledgment. The per-learning effect lock preserves promotion/withdrawal ordering; the Library identity lock remains held until the commit callback settles. Case pause and handoff can complete while preparation or remote observation is pending.

## Alternatives considered

**Check only at the beginning.** A pause, Attempt replacement, policy change or remote revocation during preparation would still permit the stale write.

**Hold the Case lock across embedding and GitHub requests.** That would delay human control behind external operations. Only the local final validation, insertion and acknowledgment need the lock.

## Consequences

The persisted schema and memory content format remain unchanged, including deterministic IDs and historical acknowledged references. An insertion followed by a lost acknowledgment remains recoverable through the existing identity/content checks. Replaying an unacknowledged insertion also requires current delivery; withdrawal and operator Library reconciliation remain available under their own authorization rules.

Tests reject unacknowledged, paused, replaced-epoch, replaced-Attempt and remotely unconfirmed deliveries. Promise barriers prove that a real Case pause completes during preparation and remote confirmation and prevents the pending write. Real Library tests verify that a refused Host commit does not insert a prepared row. The learning unit fixture supplies the external verifier explicitly; publication tests separately exercise the actual shared verifier and delivery pipeline.

Remote observation and a local database write cannot be atomic across GitHub and the Host. This checks the most recent observation and serializes local ownership changes; it does not prevent a subsequent remote edit. It also does not prove semantic lesson validity, currentness of every model-supplied evidence reference, redaction of free-form lesson text, or release availability. Keep automatic verified memory disabled until those deployment requirements are met. Embedding configuration and operation context follow [installation embedding](2026-09-08-oryn-installation-embedding.md).
