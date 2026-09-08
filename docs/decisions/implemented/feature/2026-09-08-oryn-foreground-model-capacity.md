# Decision Record: Reserve foreground model capacity alongside Oryn engineering

Status: implemented

## Problem

Oryn engineering and QA share the Agent worker pool. Engineering turns can occupy every worker or fill waiting count and byte bounds, preventing a new Feishu question from obtaining model capacity even though its Session is independent.

## Decision

A Host admission provider classifies enabled Oryn engineering and worker Session bindings as background using the canonical rollout owner. The class also applies to derived calls attributed to those Sessions. QA and unrelated owners retain foreground admission. Agent names do not grant a workload class, and classification metadata remains outside serialized worker requests.

The existing queue admits the oldest eligible turn and limits background occupancy to one fewer than the configured worker ceiling, with a minimum of one. Background submissions leave one aggregate admission position and a queued-byte reserve of the smaller of 64 MiB or half the configured byte budget. Foreground submissions still obey the original aggregate limits. No additional queue, semaphore or coordinator is introduced.

Occupancy lasts through worker release, including provider disposal. Cancellation and resize use the existing pool lifecycle. A one-worker pool remains usable but cannot reserve an independent foreground slot. Shrinking does not preempt active work; the reduced background ceiling applies as owned turns release.

## Alternatives considered

**Prioritize QA only after every worker is occupied.** Queue order cannot free a worker running a long engineering turn, and priority alone does not preserve waiting-count or byte admission.

**Create a separate QA runtime or scheduler.** This duplicates resource ownership and operational state when the existing pool can enforce eligibility itself.

**Use persistent Boss worker counts as model occupancy.** A Session can remain alive while idle or executing tools. Model capacity must track actual provider turns through physical release.

## Consequences

Tests cover Host binding and rollout-owner routing, saturated engineering occupancy, queue-count and byte reservations, aggregate bounds, provider completion before physical release, cancellation and pool growth. A real server and three model worker processes also demonstrate a third Feishu question answered while two engineering provider requests remain held, followed by recovery of the original Cases after process death. Ordinary foreground FIFO behavior and existing pool recovery tests remain in the same regression suite.

The reserved capacity is shared by foreground calls, not exclusive to QA. Provider rate limits, other foreground demand and worker startup latency can still delay a reply. Small queue-byte budgets may not hold an entire maximum-size foreground request. Total Case/Session counts, light-operation quotas, model-token budgets and OS process limits remain separate work; this change does not claim to enforce their configuration fields.
