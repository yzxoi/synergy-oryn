# Decision Record: Oryn interrupted task recovery

Status: implemented

## Problem

Boss assignment replay correctly preserved an already consumed task's identity, but it did not wake its interrupted reply. Generic continuation excludes errored assistants and intentionally does not restart ordinary interrupted conversations. An engineering root can also consume a worker report and stop before responding, even when an earlier root reply completed successfully.

## Decision

OrynResume prepares continuation for an existing, idle, unarchived engineering or worker Session. Under the Case lock it validates the current binding, epoch, Attempt and worker assignment; accepted reports and inactive or completed work are excluded. Worker recovery first revalidates configured repository ownership and replays the reserved Boss binding. Engineering recovery validates startup ownership before inspecting the existing task.

A queued Inbox item is reused. For a consumed interrupted root or unanswered report, the Host repairs incomplete assistant/tool state through SessionInvoke, then delivers a unique system steer through SessionInbox. The existing root, Session, Assignment and worktree remain authoritative. The recovery text requires inspecting artifacts and action receipts before continuing; it does not infer failure from an interrupted tool or authorize blind external replay. SessionDrive and the ordinary model/tool loop perform the work.

The delivery key uses the existing root and latest persisted history entry. Repeated recovery while that instruction is queued creates no additional item. If the instruction was consumed before another interruption, the next recovery has a distinct history anchor. Three materialized recovery instructions per root exhaust the automatic recovery budget and request a persisted human handoff. The count reads canonical message metadata rather than compacted model context, so removing an instruction from model context cannot reset the budget.

Enabled startup recovers worker turns and, after accepted-report delivery recovery, engineering turns. Explicit Case resume retries those same paths after releasing the control lock. A Host recovery handoff stops the engineering root as well as workers; only the actual ToolScheduler caller is excluded from draining itself when a running tool requests handoff.

## Alternatives considered

**Redeliver the original assignment as a new task.** This replaces task grouping and can repeat already completed work instead of continuing the recorded task.

**Enable automatic restart for every Session.** Ordinary interactive sessions intentionally leave interrupted replies under human control. Oryn owns the business state needed to decide whether continuation is still valid.

**Use one permanent recovery delivery key.** A second interruption after consuming the recovery instruction leaves no queued item, while permanent deduplication prevents another wake.

**Count only model-visible recovery messages.** Context filtering and compaction are presentation operations; they cannot be allowed to reset an execution budget.

## Consequences

Recovery reuses Session history, Inbox, Boss ownership and the existing handoff outbox; it adds no queue, persisted schema or migration. A successful recovery request means continuation is queued or scheduled, not that a model has completed the task. The budget bounds automatic recovery nudges, not all model calls or Case resource consumption.

Tests cover consumed assignments, repeated recovery, interruption after consuming the recovery instruction, budget exhaustion including hidden context, explicit pause/resume, consumed engineering roots and unanswered reports after a terminal reply. A scripted model resumes the same worker root through the actual loop and result tool, accepting one structured result without another worker. A Host handoff test holds an engineering lease and proves completion waits for cancellation and cleanup.

Full operating-system process restart, orphan-process cleanup, replacement Attempt allocation after takeover/cancel, and remote-write crash reconciliation require separate acceptance. These simulated interruption tests do not establish exactly-once arbitrary shell actions or live GitHub/Feishu delivery.
