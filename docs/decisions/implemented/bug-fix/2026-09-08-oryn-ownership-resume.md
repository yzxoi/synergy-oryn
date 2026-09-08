# Decision Record: Resume Oryn ownership with a fresh Attempt

Status: implemented

## Problem

Takeover, cancellation and human handoff advance a Case ownership epoch, invalidating its workers and publication receipts. Setting the Case back to active without replacing its Attempt leaves dispatch tied to invalidated assignments and old code-writer records. Waking the engineering Session can also consume queued work from the previous owner before a new task explains the transition.

## Decision

An explicit resume from human-owned or cancelled control reserves a fresh Attempt through the existing durable Attempt-transition owner. It retains the configured baseline or the prior frozen candidate, preserves historical evidence and repair/no-progress counters, supersedes the previous Attempt and activates the Case only after the replacement is persisted. Reproduction, verification and review must produce current-epoch evidence. This does not import human edits from a remote branch or resolve missing acceptance decisions.

The same engineering Session receives a new Host-authored task through Inbox, keyed by Case and ownership epoch. Central Session admission remains closed for that engineering Session until the new task is queued or materialized in canonical history. Before its first delivery, the Host removes obsolete pending tasks, steering and context; their already persisted messages, reports, runs and worker Sessions remain available for inspection. Repeated recovery recognizes the new task in Inbox or history and preserves subsequent work.

Runtime startup replays durable resume intents with matching control, epoch and revision, then the normal engineering recovery path validates repository/source binding and prepares the ownership task. A crash after Case activation but before Inbox delivery leaves engineering admission closed until preparation succeeds. A later takeover or cancellation invalidates an earlier resume intent. Pause/resume keeps the current Attempt and task; pausing human-owned or cancelled control requires explicitly resuming ownership first.

The migration upgrades Attempt transition v1 to v2 with `kind: rework` and `expectedControl: active`. Ownership resumes use the same versioned family with `kind: resume`, keyed by epoch. No second coordinator, model loop or execution queue is added.

## Alternatives considered

**Resume the old worker under the new epoch.** Its assignment, worktree and evidence were accepted under different ownership. Updating that identity would erase the invalidation rather than validate new work.

**Create a second engineering Session.** The existing Session retains the Case investigation and Boss lineage. A new task root supplies current instructions without discarding that history.

**Activate the Case and rely only on a prompt.** A queued old task can run before the prompt arrives. The run-admission check closes that persistence window independently of model behavior.

**Reset repair budgets on resume.** Resuming execution is not authorization to erase prior limits or approve unresolved acceptance. Counters and historical handoff reasons remain durable.

## Consequences

Tests cover takeover/cancel resume, old-worker denial, new-worker dispatch with the same logical request key in a new Attempt, loss of the Case pointer write, interrupted ownership-task preparation, canonical task replay, and v1 migration. A scripted model receives the new task, dispatches a new repro worker, reads its actual result and requests human handoff when the platform is still unavailable. Existing pause, shell containment and interrupted-task suites retain their invariants.

The baseline remains pinned to known local history. Remote human changes still require the GitHub lifecycle reconciliation and non-fast-forward protections; this resume operation does not assert that those edits were incorporated. Full process-level PR-success/repair recovery and the remaining delivery/deployment acceptance are separate work.
