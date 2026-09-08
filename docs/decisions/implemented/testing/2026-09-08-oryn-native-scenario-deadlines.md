# Decision Record: Bound native Oryn experiments by their scenario deadlines

Status: implemented

## Problem

The runtime-process fixture's receive operation waits for actual QA execution, rather than acknowledging only IPC receipt. An independent 30-second request timer could therefore abort a correct but loaded model pipeline before the scenario's own deadline. The [Ubuntu 24.04 native run](https://github.com/yzxoi/synergy-oryn/actions/runs/34222148003/job/102047544473) failed at that timer; subsequent Issue recovery passed in 54 seconds, Draft recovery passed in 127 seconds and Ready recovery passed in 94 seconds. The job then exhausted its 15-minute aggregate budget during PR repair.

## Decision

Receive waits for the execution result under the enclosing test's existing timeout. Startup, snapshot and shutdown retain their separate administrative guards, and child exit rejects pending requests. The process-restart scenario remains bounded at 180 seconds; PR-restart scenarios remain bounded at 420 seconds with their existing phase checks. Assertions, model steps, interruption points, real candidate checks and cleanup stay unchanged.

The native job has a 25-minute aggregate budget for dependency installation, helper compilation, containment/resource tests and pipeline scenarios. This budget affects only the CI job, not Case deadlines, command quotas or model scheduling.

## Alternatives considered

**Return receive acknowledgment before QA execution.** This would change what the fixture proves and weaken completed duplicate-delivery checks. The fixture continues to await the real execution result.

**Raise every IPC timeout.** Administrative IPC is not a model turn. Its existing guard remains useful for failed snapshots and shutdown; only receive uses the scenario's execution deadline.

## Consequences

A slow native runner has headroom to complete the same behavioral checks, while stalled scenarios still fail their test deadlines. A timer failure alone does not establish either a product deadlock or its absence; the changed fixture and complete native job must pass again. No product-runtime fix or live deployment result is claimed by this adjustment.
