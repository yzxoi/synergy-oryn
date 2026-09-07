# Decision Record: Durable Oryn worker handoff through Boss

Status: implemented

## Problem

Oryn dispatch wrote task Inbox items without Boss assignment metadata. A retry after worker binding could return without delivering any task. Structured worker reports neither woke the engineering root nor satisfied Boss's report-completion rule, and repeated submissions created conflicting report records.

## Decision

Oryn dispatch uses `BossService.assign`, with the Assignment ID as task ID and the existing Oryn delivery key. The host-only delivery-key option preserves deduplication for pending and materialized tasks across the change. Repeating dispatch repairs a missing delivery; the task text includes the fixed Attempt ID. Dispatch and report acceptance serialize with Case control changes. A request key cannot select another stage or review domain, and an explicit non-active Attempt is rejected.

Worker reports deduplicate by Case, Assignment and request key against their canonical schema payload. The same request returns its original record; changed content is rejected. Report kind must match the Host-assigned stage. Paused, superseded and otherwise inactive work retains reports for audit without accepting them or waking engineering.

An accepted worker report creates a durable, deduplicated steer message for the engineering root and schedules its wake. Retrying after report persistence or acceptance repairs a missing Inbox delivery; materialized notifications remain deduplicated through Session history. These messages contain report references and do not carry Channel reply metadata. Acceptance means receipt of a worker judgment, not proof that its claims are correct.

Boss exposes a task-report provider port so specialized workflows can recognize Host-persisted completion without fabricating a `boss_report` tool call. Oryn's provider checks the bound worker and exact Assignment's accepted report. Ordinary Boss workers keep their existing completion behavior, with no Oryn storage lookup for unrelated agents.

No persisted schema or storage key changes in this update. Existing delivery identities and reports remain authoritative; no data migration is needed.

## Alternatives considered

**Require another model call to report completion.** This leaves a gap between saving the structured result and notifying its consumer, and creates unnecessary continuation turns. Host delivery makes the handoff a consequence of accepting the result.

**Replace the delivery key when adopting Boss assign.** Previously materialized tasks would be delivered again. Preserving the domain's stable key lets the existing Inbox deduplication cover both versions.

**Teach Boss about Oryn record paths or tool names.** This couples the generic workflow to product-specific storage. A registered completion provider preserves the ownership of each report.

## Consequences

The behavioral suite in `packages/synergy/test/oryn/worker-handoff.test.ts` covers missing task delivery, report replay and conflict, consumed delivery deduplication, stage impersonation, pause handling and continuation after a structured report. It uses real Sessions, Inbox, Boss and Storage with held loop leases; it does not run a model or prove candidate execution.

Case-to-engineering automatic startup, recovery across an unbound worker creation, autonomous replay of partially delivered reports, structured review delivery, trusted candidate validation and execution remain separate integration work. This change does not establish deployment readiness.
