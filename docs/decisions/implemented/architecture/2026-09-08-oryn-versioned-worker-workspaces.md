# Decision Record: Oryn versioned worker workspaces

Status: implemented

## Problem

Only the coding worker received a worktree. Reproduction, verification and review inherited the engineering checkout even though their Assignments recorded fixed versions. Moving the main checkout could therefore change the source examined by a worker. The executor accepted a caller-provided working directory internally, read HEAD only after execution, and could label baseline execution as candidate evidence or report success after the command changed source files.

## Decision

Every newly dispatched Oryn worker receives its own Boss-managed worktree. Reproduction and coding start from the Attempt baseline; verification and review start from its frozen candidate. The Host records the workspace on every Assignment. Replay preserves an existing worktree and repairs missing Assignment linkage; a historical worker still using a main checkout is rejected instead of silently changing an active Session's workspace.

The check executor derives its directory from the bound worker Session and validates it against the Assignment. Before execution and between commands it checks cancellation, enabled policy, Case control/epoch, active Attempt and the requested lane's fixed commit. Before a command sequence it records clean Git HEAD/tree state and checks the expected version. It records that initial version in the receipt and checks the workspace afterward; changed source, changed inputs or lost control yields inconclusive evidence instead of a passing result. This does not make observation and process execution atomic.

`OrynGit` owns the bounded read-only Git inspection used by candidate verification and check receipts. Git status is preceded by indexed Git-link and configured-filter detection; unsupported submodules or filters require a contained inspection environment. Status does not recursively inspect submodules. Hooks, fsmonitor, inherited Git configuration and replacement objects are disabled. This prevents ordinary inspection from intentionally invoking a configured clean filter; it is not a replacement for OS containment against concurrent metadata modification.

No persisted schema changes are needed: Assignment workspace references and receipt version fields already exist. Historical main-checkout repro/verify/review Assignments need replacement through engineering after their old work is stopped. They are not rebound while active or treated as evidence of isolated execution. Dirty verification overlays are not supported by this fixed-clean-checkout path.

## Alternatives considered

**Keep the shared checkout and record only the intended SHA.** A recorded version does not control which files a command reads. Separate worktrees make normal version changes independent across workers.

**Switch the engineering checkout for each worker.** Concurrent Sessions would observe one another's branch and file changes. Boss already owns isolated worktree creation with an explicit base revision.

**Record HEAD only after execution.** A command can change source or move HEAD, causing its result to be attributed to a version it did not start with. The initial snapshot and post-run comparison make this inconsistency explicit.

## Verification

`test/oryn/workspaces.test.ts` uses real temporary Git repositories, Boss worktrees and Bun child processes to read distinct baseline/candidate source values after the main checkout moves. It verifies separate directories, isolated experimental files, invalid lane and dirty-input rejection, source-mutation invalidation, and no check side effect for paused or pre-aborted work. Candidate tests show Oryn rejects configured clean filters and Git links before inspection; a subsequent raw Git status in the isolated fixture demonstrates that the clean filter otherwise executes. Fixtures lease Sessions and do not call live models or external providers.

## Consequences

These tests establish ordinary filesystem/version separation and receipt invalidation, not secure execution of hostile code. The executor still needs to use the canonical sandbox and tool admission path, replace its custom wait queue, validate evidence provenance and bind complete policy/plan versions. Git-linked worktrees share repository metadata, and ignored build artifacts remain outside Git status evidence. Full scripted-model maintenance fixtures, live Feishu/GitHub canaries and Linux deployment acceptance remain separate requirements.

Bounded physical execution and cancellation are defined by [check process lifecycle](../bug-fix/2026-09-08-owned-check-process-lifecycle.md); they do not establish OS containment.
