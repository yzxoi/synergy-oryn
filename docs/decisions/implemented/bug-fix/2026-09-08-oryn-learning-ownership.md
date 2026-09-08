# Decision Record: Apply Case ownership to learning mutations

Status: implemented

## Problem

A durable source binding identifies where a session came from, but does not establish that the session still owns an active Case. Learning proposal and withdrawal accepted those bindings after pause, takeover, cancellation and Attempt replacement, allowing an obsolete worker to mutate shared knowledge.

## Decision

Learning mutations validate the active Case, its wall-clock budget and the actual unarchived Session. Engineering must be the current Case root with the reserved agent identity. Workers must have a matching assignment in the current ownership epoch and Attempt, the assigned agent and the current engineering parent. A completed assignment in the current Attempt can still contribute or withdraw a lesson; a historical assignment cannot.

Proposal validation and creation hold the existing Case lock, which also serializes identical proposals. Withdrawal acquires the learning effect lock, then the Case lock, and revalidates ownership before its Library removal. This preserves the effect ordering from [learning write recovery](2026-09-08-oryn-learning-write-recovery.md) while preventing an inactive Case from entering the removal path.

## Alternatives considered

**Trust the persistent source binding.** Bindings survive restart and preserve historical provenance; they are not revocable execution authority.

**Rely only on tool visibility.** Domain calls and already-running callbacks still need to validate current ownership before changing persistent knowledge.

## Consequences

Tests reject mutations from paused, human-owned, cancelled and closed Cases, and from workers replaced by a new epoch or real rework Attempt. Current workers remain supported and expired unfinished Cases cannot create learning records. No persisted fields or migration are added. Operators must use the authorized Library management surface to correct knowledge from an inactive Case, or explicitly resume Case ownership before using engineering tools. Host promotion eligibility and semantic lesson validation remain separate from caller authorization.
