# Decision Record: Oryn check subprocess containment

Status: implemented

## Problem

Oryn's check quota and process lifecycle code used an unwrapped command and inherited HOME. Versioned worktrees prevented accidental workspace reuse but did not prevent a test from changing source or reading host data. Reusing the interactive wrapper defaults would also grant user toolchain/cache paths and workspace writes beyond the check's requirements. The Linux helper's second stage could lose access to its executable and policy when the private root and temporary filesystem were mounted.

## Decision

Oryn checks use the shared sandbox executor with an explicit Host permission profile: read-only pinned source, system runtime files and the approved executable, a disposable writable HOME/temp directory, and restricted networking. No credentials, SSH agents, provider variables or language startup variables are inherited. Cleanup remains inside the scheduler's physical execution lifetime. Sandbox denial, including Linux EROFS/read-only-filesystem errors, becomes inconclusive infrastructure evidence; it cannot become a reproduced bug or passing verification.

`SandboxBackend.prepareWrapper` forwards the complete profile to Linux and the default macOS compiler. The latter omits interactive platform/user allowances for explicit profiles, retains OS process bootstrap requirements, and prevents imported OS rules from widening writes or restricted networking. Legacy, disabled and unsupported explicit-profile backends return unavailability. Linux mounts the helper and its immutable policy at private read-only bootstrap paths after other mounts, without exposing their host parent directories.

Local Oryn checks accept only sandbox isolation. `worktree`, an unconnected `external_vm`, and unsupported UID/cgroup/browser/network-egress requirements fail before spawning. Namespace/seccomp declarations require Linux and successful helper startup. Ordinary coder Bash, model capacity reservation, cross-platform desktop testing and build/experiment staging remain separate work. Read-only source tests cannot write build outputs into their checkout; that environment gap is reported rather than silently widening source permissions.

## Alternatives considered

**Reuse interactive sandbox defaults.** Those support a developer's shell, user toolchain caches and writable Git workspace; they exceed the check's accepted roots.

**Use only an environment allowlist.** A process can read credentials through filesystem access even when the corresponding variables are absent.

**Allow worktree-only execution when the sandbox is unavailable.** This reproduces the original exposure and defeats unattended execution policy.

## Consequences

The actual Oryn check path now depends on an available OS sandbox. Deployments and CI must supply the Linux helper and Bubblewrap; namespace restrictions remain real environment failures. Ubuntu CI loads the Bubblewrap AppArmor profile when unprivileged namespaces are restricted, using the installed distribution copy or a SHA-256-verified copy from a pinned AppArmor 4.0.3 commit when the package omits it, and probes namespace startup before running candidate checks. The CI provisioner only runs on disposable GitHub-hosted VMs; it does not disable host-wide restrictions or alter production machines. Deployment guidance follows the [Ubuntu namespace policy](../../../operations/oryn-deployment.md#ubuntu-namespace-policy). Missing execution capabilities need human intervention or an independently implemented authorized runner, not an automatic permission escalation.

`test/sandbox/explicit-profile.test.ts` tests final helper policy transport, backend rejection and native macOS filesystem/network behavior. `test/oryn/sandbox.test.ts` exercises disposable HOME, source and symlink protection and unsupported capabilities. The existing workspace suite verifies integration with real check admission and source-version tracking. The Oryn Native Containment workflow runs the Linux path on Ubuntu 22.04 and 24.04 VMs without Docker, including ordinary nonzero command results and the review pipeline; a compiler/serialization test or a passing macOS run alone does not establish Linux execution. RunReceipt authenticity and full delivery evidence still require independent validation and are not granted by successful process execution.
