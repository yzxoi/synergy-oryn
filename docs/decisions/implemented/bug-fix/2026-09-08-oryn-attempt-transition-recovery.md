# Decision Record: Recoverable Oryn Attempt transitions

Status: implemented

## Problem

Rotating an Oryn Attempt changes several durable records: the previous Attempt disposition, the replacement Attempt, the Case pointer and counters, and its derived index. An interruption between those writes can leave the old Attempt superseded without a linked replacement, create extra replacements on retry, or report failure after the Case pointer already advanced.

## Decision

The store writes a version 1 transition intent under the Case, keyed by the previous Attempt identity, before changing either Attempt. It reserves the replacement identity and complete initial record, exact transition inputs, ownership epoch, expected Case revision and resulting repair counters. Under the existing Case lock, replay validates the same input and epoch, reuses the reserved replacement, supersedes the previous Attempt once and advances the Case pointer and revision once. A completed replay repairs the Case index without incrementing counters or discarding later replacement evidence.

Runtime startup reconciles these intents before Session recovery can wake model work. Completed historical transitions whose replacements are no longer active are skipped. Incomplete transitions whose Case revision changed are paused for inspection rather than overwriting intervening decisions. Human-owned, cancelled and stale-epoch work is not resumed through this recovery path.

The intent is local recovery metadata in the existing Oryn store, not another execution queue. Attempt v1 and Case v2 formats remain unchanged. This adds a new record family; no upgrade of existing records is needed, and no intent is fabricated for historical transitions lacking one.

## Alternatives considered

**Generate a new replacement identity on every retry.** This leaves duplicate Attempts and cannot distinguish a lost acknowledgment from an unapplied pointer update.

**Infer a replacement from timestamps or an unlinked Attempt.** Similar baselines do not prove ownership of a particular transition or its counter effects.

**Use a separate transactional database for Oryn.** The existing Storage and Case locks remain sufficient when intent and replay semantics explicitly cover each write boundary.

## Consequences

The regression suite interrupts replacement creation, previous-Attempt persistence, Case publication and index projection, then exercises the same recovery owner used at startup. It asserts one replacement, preserved identity, one counter increment, immutable transition input and epoch fencing. Existing review and scripted success/repair suites cover ordinary progression.

Backups must include transition intents alongside Case and Attempt records. Recovery cannot reconstruct transitions that predate intent persistence. Human takeover/cancel followed by resume still requires its own new-Attempt and engineering-task admission integration; this change supplies recoverable rotation without claiming that integration is complete. A process-level PR-repair interruption scenario remains separate acceptance work.
