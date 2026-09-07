# Decision Record: Oryn notification identity and uncertain dispatch

Status: implemented

## Problem

Deduplicating every answer by source and kind suppresses later questions in the same conversation. Concurrent outbox writers and drainers can also create and send duplicate notifications. A send that times out may already have reached Feishu, so keeping that entry pending and retrying it cannot guarantee quiet delivery. QA source bindings require a Case access check before accepting a notification about that Case.

## Decision

The Oryn service admits replies only from QA bindings and checks source membership for Case-specific replies. Conversational replies use the root message identity supplied by the tool host; model parameters cannot select that identity. Lifecycle replies use the current attempt when one exists. Deduplication includes the recipient source, so separate subscribers never suppress each other's notifications. A per-key lock serializes intent creation.

Before calling a transport, the store atomically claims a pending intent by persisting `ambiguous` with its attempt timestamp. Only the winning drainer calls the transport. A confirmed response settles the record to `delivered`; errors or process interruption leave uncertainty visible and do not trigger an automatic resend. A missing transport leaves the intent definitely unsent and pending. The state intentionally becomes ambiguous before network I/O: local storage and the remote API cannot commit atomically, including a crash immediately before the call.

Outbox schema version 2 distinguishes pending from ambiguous. The centrally registered `20260908-oryn-outbox-dispatch` migration preserves entry identifiers and delivered/suppressed records. Version 1 pending entries become ambiguous because the old writer did not record whether a send had occurred. The migration validates records, propagates storage failures, and is safe to rerun.

## Alternatives considered

**Retry every send error.** A missing response is not proof of a failed remote write; retrying can duplicate an already visible message.

**Deduplicate by message text.** Repeated user questions may correctly receive identical answers, while retries may rephrase the same notification. Host-owned turn identity expresses the intended operation.

**Assume old pending records were never sent.** Version 1 retains pending after all send errors and crashes. Migration cannot recover that missing fact, so automatic replay would be unsafe.

## Consequences

Tests cover subsequent answers, unauthorized Case references, concurrent intent creation and dispatch, lost responses, interruption after claim, missing transport, and upgrade idempotence. Unknown outcomes require authoritative provider evidence or human reconciliation; this change does not claim remote exactly-once delivery or a live Feishu canary. Channel ingress and transport lifecycle integration require their own behavioral evidence.
