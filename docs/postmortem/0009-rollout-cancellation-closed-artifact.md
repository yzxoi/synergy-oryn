# Rollout cancellation closed an artifact before its pending bytes arrived

## Executive summary

A model-driven Oryn reproduction sometimes stored its report but could not resume engineering. Cancellation could close a model transport artifact while a pending read still held received bytes. The subsequent write correctly failed and closed execution admission. The fix orders read cancellation, prefix commitment, both body completions and attempt completion; the evidence failure policy remains strict.

## Summary

The engineering mock entered real ChannelHost, QA tools, Boss assignment, worktree execution and report delivery. Some runs completed, while others left a report in the engineering transcript without a follow-up model call. This was observable locally; no live Feishu or deployed VPS incident was established.

## Timeline

- On September 8, the real reproduction mock exposed a missing human-handoff notification, which led to durable handoff outcomes and reporter delivery.
- Repeated runs then exposed an intermittent stop after report materialization. Longer waits did not complete the task.
- Scoped diagnostics showed that wake occurred but admission rejected a rollout already marked as recording-failed. Tracing the original failure identified a chunk write to a closed transport artifact.
- A barrier-based transport test reproduced cancellation while a read held a prefix and awaited more bytes. It failed because body completion preceded the chunk record.

## Root cause

The transport batches small reads before forwarding them. Its cancel handler cancelled the upstream reader and immediately emitted body-end. Releasing the pending read allowed the pull handler to continue with its buffered prefix; that handler could emit the chunk after body-end had sealed the artifact. The record writer rejected the late write, and the run's fail-closed admission prevented subsequent engineering execution.

A second ordering gap allowed a response to finish the transport attempt while an upload was still pending. The recorder could then reject a request event because the attempt had already been removed. Attempt finalization must await both body owners, and concurrent finalizers must share one completion promise.

Existing cancellation coverage waited for a chunk to reach the consumer before cancelling. It did not cover a buffered prefix still inside an outstanding read. Repeated pipeline tests made the scheduling overlap visible but were not a deterministic regression by themselves.

## Guardrails added

- [Transport cancellation](../../packages/synergy/src/session/rollout/transport.ts) releases the reader, awaits the active pull's recording work and only then closes the body and attempt. Bytes already received remain recorded even when the consumer has cancelled.
- [Transport tests](../../packages/synergy/test/session/rollout-transport.test.ts) use a blocked upstream read to assert prefix retention, event ordering, reader release and an early response with a pending upload. Existing persistence-failure tests keep their rejection behavior.
- [Engineering pipeline](../../packages/synergy/test/oryn/engineering-pipeline.test.ts) exercises report-driven continuation and reporter delivery through the real runtime. Temporary diagnostic replacements used during investigation are removed from the fixture.
- The [testing guide](../../.synergy/skill/testing-guide/SKILL.md) requires both pending-read and delivered-chunk cancellation coverage for recorded streams.

## Lessons

Cancelling a stream does not mean its pending pull has finished recording. Closing evidence requires awaiting that work, not suppressing its errors or discarding its received prefix. A missing continuation can be a consequence of an earlier evidence failure rather than a queue or wake defect.
