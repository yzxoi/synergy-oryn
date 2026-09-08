# Decision Record: Durable Oryn human handoff and reporter delivery

Status: implemented

## Problem

The engineering root can transfer ownership to a human without preserving the reason or reaching the Feishu reporter. A successful worker report and final model response therefore leave a silent Case that an operator cannot act on from the task detail. Relying on a later QA inference introduces an additional failure point and can duplicate notices.

## Decision

Case schema version 2 stores an optional handoff reason, epoch and request timestamp. The Case lock serializes ownership changes; repeating the same handoff is idempotent, while a different request cannot overwrite existing human ownership. The central migration upgrades version 1 Cases without guessing missing reasons.

The service authorizes the QA or engineering root, persists the handoff, then queues an existing outbox intent for each bidirectionally linked, currently routed Feishu source owned by a QA conversation. Deduplication binds the source, Case and handoff epoch. Startup recovery repairs missing intents; an explicit QA needs-human reply reuses the same operation. Public projections replace recognized private text with an operator-workspace instruction, while private Case storage retains the reason.

The outbox suppresses notification kinds disabled by installation policy, unlinked recipients and handoffs superseded by a resumed or changed Case. A missing transport leaves an intent pending. Dispatch continues to use the existing ambiguous-before-send protocol: uncertain outcomes never automatically resend. The task detail route uses the schema in generated OpenAPI/SDK types, and the Oryn panel renders the projected reason for human-owned Cases.

## Alternatives considered

**Wake QA to explain the handoff.** Reporter delivery would require another model call and allow divergent summaries or duplicate messages. The persisted outcome already contains the actionable reason.

**Write only an outbox entry.** A failure before intent creation loses the handoff explanation, and the operator view cannot reconstruct it. Canonical Case state must precede the derived notification.

**Assume a legacy reason or retry ambiguous delivery.** Neither missing information can be recovered from local state. Migration and recovery preserve uncertainty rather than manufacture evidence or duplicate remote messages.

## Consequences

Behavioral tests cover canonical-write interruption, recovery, response loss, repeated QA delivery, source unlinking, resume and a subsequent handoff, authorized fanout, notification filtering, migration idempotence and public API redaction. A scripted-model fixture executes an actual Boss baseline reproduction and report-driven handoff through the ChannelHost and verifies the reporter response. This does not establish live Feishu delivery, arbitrary-secret detection, immediate worker cancellation, or the candidate-to-PR pipeline.
