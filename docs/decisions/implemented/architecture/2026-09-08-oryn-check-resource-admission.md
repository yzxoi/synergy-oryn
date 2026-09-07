# Decision Record: Oryn check resource admission

Status: implemented

## Problem

Oryn check calls used the control-plane executor class and then waited in a second process-local queue. A profile waiter held an outer heavy slot before it could acquire its profile slot. The shared unkeyed wake list did not reliably wake an eligible waiter and queued cancellation could not remove the wait. Ordinary tool completion could also release scheduling capacity before an interrupted physical process had finished cleanup.

## Decision

The existing `ToolTaskScheduler` accepts optional Host-owned resource quotas on a tool dispatch. It copies and bounds this metadata independently of model arguments. Admission atomically checks the global limit, executor limit and all requested resource counts before starting a task; a blocked resource waiter consumes none of those active counts. Drain selects the first eligible queued task, allowing a different profile to use available capacity. Cancellation, queue bounds, execution identity and shutdown remain owned by this scheduler.

`ToolExecutor` owns first-party admission-provider registration. The processor resolves Host metadata after the Agent stream is disposed and before dispatch. Providers can choose an executor and resource requirements; their callbacks are never included in the model catalog or Agent stream input. Plugin/local executor classifications do not invoke a same-named built-in provider. Admission and metadata-validation failures settle the individual tool call without executing it or failing unrelated calls; durable rollout failures retain their existing fatal handling. This scheduling metadata does not replace capability authorization at the resolver.

Oryn registers admission for `oryn_check`. Read/propose actions use control-plane scheduling. Run actions validate the worker, Case, Assignment, Attempt, plan and installation configuration, then use `local_process` plus the configured Oryn check-heavy and profile quotas. The executor rechecks that its live Session execution context holds those exact configured quotas before approving or executing a plan. A changed quota requires fresh admission; an unscheduled direct call cannot execute. The old private lane map and waiter list are removed.

An execution-scoped context records the admitted Session, executor and immutable quotas. It is unavailable outside the admitted callback and becomes inactive when that callback returns. Oryn registers its physical runner promise with this context. The scheduler retains capacity until registered physical work settles, including when the resolver has already returned a cancellation or timeout result. Runtime shutdown keeps its existing bounded grace and closed admission; it does not retry unfinished side effects.

These resource counters bound Oryn check calls. They do not yet charge coder Bash/background jobs to Oryn profile budgets, reserve QA model capacity, enforce CPU/memory cgroups or provide OS isolation. The existing global per-executor scheduler limit still applies to ordinary tools. Resource quotas are transient admission data, not another persisted execution queue or authorization grant.

## Alternatives considered

**Repair the private semaphore queue.** It would keep duplicate queue state, outer-slot occupancy and separate cancellation behavior. Atomic resource requirements belong to the existing scheduler.

**Classify every Oryn check action as a process without profile quotas.** That limits processes globally but treats reads as heavy work and loses installation profile limits. Host admission can select the action-specific executor and quotas without trusting model-supplied limits.

**Release capacity when the provider-visible tool result settles.** The resolver may settle cancellation before the physical implementation returns. Explicit physical-work registration preserves the resource count until cleanup finishes.

## Verification

`test/session/tool-resources.test.ts` uses barriers to verify atomic profile/global admission, eligible-profile progress, queued cancellation, execution-context scope and retention while physical work is pending. `test/session/tool-executor.test.ts` verifies Host-controlled metadata, plugin classification and pre-abort. Processor tests use a scripted Agent stream to verify admission after disposal, execution with the selected quotas, individual rejection settlement and unrelated-call progress after malformed quotas.

Oryn fixtures submit real Case/Assignment/plan data through the registered admission provider and a real ToolTaskScheduler before invoking the check service. Worktree tests execute actual local commands and reject a direct unscheduled check without changing its plan status. These are component/integration tests, not the complete scripted-model maintenance pipeline or a live Feishu deployment.

## Consequences

Check waiters stop occupying unrelated profile capacity and cancellation uses the canonical task lifecycle. Installation quota changes can reject an already-admitted call; callers need a fresh tool call using the current configuration. No persisted-state or public model-schema migration is required. OS sandbox installation, complete execution provenance, broader resource accounting, QA fairness and final maintenance-pipeline acceptance remain necessary for deployment.
