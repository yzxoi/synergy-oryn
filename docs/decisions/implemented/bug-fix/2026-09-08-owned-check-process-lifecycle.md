# Decision Record: Owned check process lifecycle

Status: implemented

## Problem

Oryn collected complete stdout and stderr before truncating the displayed text, killed only the direct child on timeout, and could return passing evidence after output loss. The shared asynchronous sandbox runner also stopped draining a pipe when its output cap was exceeded, did not count the final partial chunk toward the shared limit, and left temporary profiles outside cleanup on spawn or hook failures.

## Decision

`SandboxBackend.executeAsync` owns bounded physical execution through the existing `Shell.prepareOwnedProcessGroup`, `Shell.killTree` and `ChildProcessClose.wait` helpers. Both output streams are consumed continuously. Their retained bytes and callback delivery share one limit; excess bytes are discarded while the pipes continue draining. Output-consumer errors terminate execution and reject the call.

Cancellation before spawn rejects without creating a process. Timeout and cancellation remain active while an asynchronous spawn hook is pending. Cleanup covers fallback denial, spawn failure, hook failure, output failure, normal exit and cancellation: it removes the listener and timer, terminates owned work, waits for bounded pipe draining, stops diagnostics and removes the temporary profile. On Unix, owned process groups include ordinary descendants; this is lifecycle management, not protection against a hostile process escaping its group. Windows continues to use the existing taskkill path and does not gain Job-object containment from this change.

Callers can set `inheritEnv: false` to supply an exact environment rather than adding to the default sandbox allowlist. Oryn uses this option to preserve its narrower inherited-variable set. This option controls environment inheritance; it does not restrict filesystem access to credentials.

Oryn check commands reuse this physical runner with a combined 64 KiB retained-output limit per command. Timeout, cancellation or output truncation stops the remaining command sequence. Truncation produces an inconclusive receipt with an explicit observation and infrastructure-failure flag, so lost output cannot satisfy a passing-evidence requirement.

This change does not activate an OS sandbox for Oryn: its wrapper remains explicitly uncontained. Installing the execution wrapper, enforcing profile capabilities, replacing the custom admission queue and proving receipt authenticity remain necessary before unattended untrusted-code deployment. The wrapper preparation and authorization decisions remain separate from physical process ownership.

## Alternatives considered

**Fix only Oryn's private runner.** Shared plugin shell execution already uses the asynchronous sandbox runner and has the same output and cleanup defects. Reusing the repaired owner avoids another process-lifecycle implementation.

**Stop reading at the output limit.** A writer can block on a full pipe, delaying completion until timeout. Continuous draining bounds retained data while allowing finite commands to finish.

**Kill only the command PID.** Descendants can retain output pipes or continue running after their parent exits. Existing process-group and bounded-drain helpers provide the appropriate Unix lifecycle behavior.

## Verification

`test/sandbox/async-execution.test.ts` executes real local child processes for shared output limits, pre-abort, spawn and hook errors, denied fallback, timeout during a pending hook, exact environment, output callback failure and Unix cancellation of a descendant that ignores SIGTERM. These tests use unwrapped commands and prove runner behavior, not native sandbox containment. `test/oryn/workspaces.test.ts` runs a real oversized-output check in an assigned Git worktree and requires an inconclusive receipt.

## Consequences

Output callbacks receive only retained bytes, and a call can report truncation when inherited output pipes fail to close within the existing drain grace. Callers requiring complete evidence must treat truncation as incomplete. Existing consumers retain their environment defaults and structured non-zero exit handling. Oryn still needs complete sandbox/admission integration, trusted behavioral evidence and full maintenance-pipeline acceptance; this decision does not establish production readiness.
