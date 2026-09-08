# Decision Record: Durable Oryn worker handoff through Boss

Status: implemented

## Problem

Oryn dispatch wrote task Inbox items without Boss assignment metadata. A retry after worker binding could return without delivering any task. Structured worker reports neither woke the engineering root nor satisfied Boss's report-completion rule, and repeated submissions created conflicting report records.

## Decision

Oryn dispatch uses `BossService.assign`, with the Assignment ID as task ID and the existing Oryn delivery key. The host-only delivery-key option preserves deduplication for pending and materialized tasks across the change. Repeating dispatch repairs a missing delivery; the task text includes the fixed Attempt ID. Dispatch and report acceptance serialize with Case control changes. A request key cannot select another stage or review domain, and an explicit non-active Attempt is rejected.

Worker reports deduplicate by Case, Assignment and request key against their canonical schema payload. The same request returns its original record; changed content is rejected. Report kind must match the Host-assigned stage. Paused, superseded and otherwise inactive work retains reports for audit without accepting them or waking engineering.

An accepted worker report creates a durable, deduplicated steer message for the engineering root and schedules its wake. Retrying after report persistence or acceptance repairs a missing Inbox delivery; materialized notifications remain deduplicated through Session history. These messages contain report references and do not carry Channel reply metadata. Acceptance means receipt of a worker judgment, not proof that its claims are correct.

Boss exposes a task-report provider port so specialized workflows can recognize Host-persisted completion without fabricating a `boss_report` tool call. Oryn's provider checks the bound worker and exact Assignment's accepted report. Ordinary Boss workers keep their existing completion behavior, with no Oryn storage lookup for unrelated agents.

Assignments reserve their worker Session ID before Boss creation and repair the Attempt's assignment link on replay. `BossService.spawn` accepts a Host-only reserved identity, serializes creation by that identity and uses `Session.recoverCreation` to repair missing indexes. Recovery verifies parent, Scope, role, agent and standing instructions. It reuses the Session's owned worktree or binds an already registered worktree whose base matches the request; it preserves source changes. Missing previously bound Sessions, changed identities, conflicting owners, stale worktrees and failed setup remain errors. Ordinary unreserved Boss spawning keeps its existing cleanup behavior.

Startup replays unfinished Assignments through the same dispatch path after engineering validates the configured repository, origin and source route. It operates in the engineering Scope, skips accepted reports and invalidated Assignments, and respects disabled or human-owned Cases. Boss assignment replay wakes a still-runnable Inbox item even when its delivery already exists; consumed deliveries remain deduplicated. This recovers worker creation and pending dispatch without creating a separate queue or scheduler.

No persisted schema or storage key changes in this update. Existing delivery identities and reports remain authoritative; no data migration is needed.

## Alternatives considered

**Store the worker identity after spawning.** A process can lose the spawn response before linking the Session, leaving a retry unable to distinguish the created worker from unrelated children. Reserving the identity before the first Session write makes recovery explicit.

**Require another model call to report completion.** This leaves a gap between saving the structured result and notifying its consumer, and creates unnecessary continuation turns. Host delivery makes the handoff a consequence of accepting the result.

**Replace the delivery key when adopting Boss assign.** Previously materialized tasks would be delivered again. Preserving the domain's stable key lets the existing Inbox deduplication cover both versions.

**Teach Boss about Oryn record paths or tool names.** This couples the generic workflow to product-specific storage. A registered completion provider preserves the ownership of each report.

## Consequences

The behavioral suite in `packages/synergy/test/oryn/worker-handoff.test.ts` covers missing task delivery, report replay and conflict, consumed delivery deduplication, stage impersonation, pause handling and continuation after a structured report. It uses real Sessions, Inbox, Boss and Storage with held loop leases; it does not run a model or prove candidate execution.

`test/oryn/worker-start.test.ts` injects lost spawn responses, missing Session indexes, worktrees registered before binding and missing Attempt links. It also checks simultaneous replay, startup from the global Scope, preserved source files, changed role/origin rejection, disabled/takeover behavior and consumed-delivery deduplication. These are real persistence/Session/Boss/Git fixtures with scheduling captured; the scripted pipeline independently exercises actual model/tool execution.

An OS crash during Git worktree creation before its registry write can leave an unregistered checkout; this path does not infer ownership or delete it automatically. Recovery of an interrupted model turn whose task was already consumed remains separate from creation/Inbox recovery. Host process sandboxing, trusted execution and live provider acceptance remain required for deployment readiness.
