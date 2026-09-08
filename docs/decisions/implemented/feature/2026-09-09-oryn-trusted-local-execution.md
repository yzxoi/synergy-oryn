# Decision Record: Explicit trusted local Oryn execution

Status: implemented

## Problem

Some managed Linux environments permit child processes and namespaces but prohibit the proc mount required by the Oryn sandbox. Operators who deliberately trust the execution environment need an executable path that does not depend on OS containment.

## Decision

The installation can select `oryn.executionMode: "trusted_local"`. It overrides check-profile isolation and selects unwrapped execution for both verification commands and engineering Bash. The default remains sandbox, and sandbox failures never trigger automatic trusted execution. Project configuration cannot select the installation mode.

Trusted local processes use the runtime OS user's existing filesystem and network access. Disposable checkouts, clean subprocess environments and shadow Git metadata remain workflow facilities, not containment guarantees. A process can read or modify other paths accessible to that OS user, including runtime data. No separate UID or cgroup is implied.

New engineering roots select the existing full_access control profile; children inherit it through the standard Session profile contract. Existing roots retain their selected profile. Role-specific tool restrictions, assignment validation, candidate freezing, source-change detection, independent review and publication gates remain in force.

The Host Bash policy explicitly marks authorized unwrapped execution. The generic Bash executor accepts that marker without pretending the wrapper is sandboxed; an unmarked failed sandbox still fails. Process ownership, cancellation, timeouts and bounded output continue through the existing runners.

Check receipts record the actual mode in Host-authored observations. No persisted record shape changes. Existing receipts remain unchanged. Explicit capability and process-resource requirements still have to be satisfied; changing mode does not silently remove them.

## Alternatives considered

**Automatic fallback after sandbox failure.** An infrastructure error must not change the installation's execution trust policy.

**Reuse the outer proc mount.** This changes process visibility and still depends on container mount behavior. It does not implement the operator's requested unrestricted filesystem and network execution.

## Consequences

Trusted execution can operate without Docker, systemd, cgroups or proc mounts when process-resource requirements are omitted. It does not escape restrictions imposed by the outer platform. Operators should finish or stop existing engineering tasks before changing mode and start new tasks with the selected control profile.

## Validation

Real child-process tests prove network access, writes outside the worktree, timeout, pre-abort and rejection of unavailable required capabilities. The real ToolResolver worker path verifies inherited full_access and an explicitly unsandboxed Host wrapper. The feedback-to-PR fixture runs in both sandbox and trusted-local modes and checks mode provenance in execution receipts.
