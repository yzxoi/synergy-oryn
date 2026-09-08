# Decision Record: Oryn Case execution control

Status: implemented

## Problem

A Case control transition changed persisted state without stopping its engineering Session, worker loops or background commands. Inbox arbitration could awaken work for an inactive Case. Cancelling the model-facing tool promise could also return before a pending shell preparation callback spawned its child.

## Decision

OrynControl owns production pause, takeover, cancel and human-handoff effects. It persists the existing Case transition first, signals the bound engineering and worker Sessions, waits for their loop and built-in execution callbacks, then terminates their registered process groups and awaits physical cleanup. Ownership comes from Case/Assignment identities and matching source bindings, including historical assignments. QA Sessions remain available. A tool-initiated transition excludes its caller from Session cancellation/draining so the tool can finish; owned background processes are still stopped, and the Session run policy prevents another inference afterward.

SessionRunPolicy is a Host registration point shared by SessionManager admission/wake, SessionDrive arbitration and SessionInvoke inference/Inbox draining. Oryn permits only active, current engineering or worker bindings; unbound reserved agents cannot execute. Ordinary unbound Sessions retain their existing behavior. SessionManager attributes physical built-in execution promises to their Session so per-Session draining can wait beyond the resolver's prompt cancellation. Local Bash checks cancellation before preparation and again immediately before spawn, cleaning prepared artifacts on rejection.

The control lock uses non-waiting acquisition. A concurrent transition receives a retryable domain conflict instead of waiting inside a Session callback that the lock holder is draining. Resume cannot race unfinished cleanup. Persisted inactive Cases are revisited during enabled startup before engineering and worker recovery; the existing Case record is the recovery input, with no new queue, receipt or migration.

## Alternatives considered

**Only check state in Oryn tools.** Already running shell commands and ordinary Session continuation do not pass through another Oryn tool before doing work.

**Treat prompt cancellation as physical completion.** The resolver settles promptly on abort while an underlying built-in callback may still be preparing or cleaning a process. Waiting on the Session loop alone misses that lifetime.

**Wait for the control lock from every caller.** A human pause can own the lock while draining an engineering tool that is itself waiting to hand off the same Case. Rejecting concurrent transitions avoids that cycle and prevents resume during cleanup.

## Consequences

Successful external control returns after owned registered work settles; cleanup failures leave the authoritative Case inactive. Startup can retry cleanup of processes still represented in the current runtime registry. This does not discover orphan processes from a previous operating-system process, enforce cgroup limits, or establish atomic author leases across every file tool. Arbitrary plugin/MCP callback containment is outside this integration.

Pause preserves queued task Inbox entries; resume asks the existing SessionDrive to arbitrate them. Consumed interrupted turns are not reconstructed, and takeover/cancel invalidate worker epochs without allocating a replacement Attempt on resume. Those recovery semantics remain required before deployment acceptance. QA is not cancelled merely because one associated Case stops.

Actual resolver and API tests exercise background termination for pause/takeover/cancel, queue suppression and resume wake, direct run rejection, QA isolation, worker cleanup barriers, concurrent-control rejection, inactive-Case recovery and abort during shell preparation with no late child or leaked scratch. Scripted model pipelines and ordinary Session/tool suites provide shared-runtime regression coverage.
