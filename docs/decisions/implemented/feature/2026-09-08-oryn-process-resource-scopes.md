# Decision Record: Bound Oryn command resources with Linux scopes

Status: implemented

## Problem

Scheduler admission bounds simultaneous commands but cannot stop one build or its descendants from consuming the host's memory, CPU or process capacity. Killing a process group also does not contain a detached descendant's lifetime after the runtime crashes.

## Decision

Installation `oryn.limits.processResources` supplies a ceiling for check and worker Bash commands. A check profile can request stricter `resourceLimits`; it cannot exceed installation ceilings. These optional limits require Linux cgroup v2 and the dedicated account's user systemd manager. They do not change the existing ToolScheduler, Session or Boss ownership model.

The Host creates a uniquely named transient scope through systemd, with memory, zero swap, CPU, task-count and maximum-lifetime properties. A trusted runner verifies the scope identity and actual cgroup filesystem and memory/CPU/task limits before starting the sandbox wrapper. The runner starts in a fresh Host directory and home so candidate Bun startup configuration cannot execute outside the sandbox. The sandbox receives its original restricted environment without the user manager's bus connection. Scope lifecycle follows the existing physical process cleanup path; a stop operation also terminates detached descendants. The systemd lifetime cap remains effective when the Host disappears.

A missing final Host report, unavailable controller or memory/task exhaustion rejects trusted check completion as an environment failure. Worker Bash receives the same installation ceiling and retains its existing process-registry ownership. Resource scopes do not grant filesystem or network access. The implementation uses scope semantics documented in the [systemd 249 source](https://github.com/systemd/systemd/blob/v249/man/systemd-run.xml); controller delegation must be provisioned because the [upstream user manager unit](https://github.com/systemd/systemd/blob/v249/units/user%40.service.in) does not delegate CPU by default.

## Alternatives considered

**Rely on scheduler counts and command timeouts.** Neither bounds memory/process use, and Host timeouts do not survive Host death.

**Use address-space limits for Bun.** Virtual-address reservations do not represent resident memory and can prevent runtime startup without providing useful host capacity allocation.

**Create another job broker.** The existing tool execution layer already owns admission, cancellation and physical completion. A transient OS scope supplies resource control without a second task queue or agent.

## Consequences

Native Linux tests exercise a successful sandboxed command, resource exhaustion, independent lifetime enforcement, detached descendant cleanup, worker Bash and candidate startup-configuration exclusion. Unsupported platforms reject configured resource requirements. The global ceiling/profile projection is tested independently of OS availability. No Case persistence migration is needed; configuration and generated API types describe the optional limits.

These are per-command ceilings, not total worker/Case quotas or reserved QA memory. Dependency materialization and other Host operations remain outside command scopes. Operators must bound the dedicated user's aggregate consumption and validate actual workload peaks. Automatic discovery of scopes left by a previous Host is not implemented; their systemd lifetime is bounded and stopped-runtime inspection remains necessary. See [deployment resource controls](../../../operations/oryn-deployment.md#linux-process-resource-limits).

Controller delegation is provisioned through the dedicated user-manager unit configuration before Oryn starts. Ubuntu native CI rejects changing DelegateControllers through set-property on the running service, so the ephemeral test setup installs a runtime unit override and starts the manager with that configuration.

The test account enables lingering before manager startup, matching unattended deployment provisioning. Setup failures retain the manager's unit status and bounded journal context so distribution-specific startup failures can be diagnosed without weakening command enforcement.
