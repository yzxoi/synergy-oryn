# Decision Record: Oryn worker process ownership

Status: implemented

## Problem

Worker Bash was contained, but process control used a global registry without Session ownership. A worker could discover another process and read its output or mutate its stdin/lifecycle. Kill/remove and stale-PID inspection could also mark a process finished while its executor was still draining output, terminating descendants or removing scratch.

## Decision

Local Bash records its Host-supplied Session identity in ProcessRegistry. Finished records retain that identity. Ownership is internal process state; model inputs cannot select an owner, and unknown legacy processes are not adopted from cwd, command text or caller claims.

A Host-only process access provider is selected by the central ToolResolver after normal authorization. Oryn validates the worker binding and assignment identity, requires the built-in local executor and limits all process operations to the caller's own entries. List filters both running and finished records; direct foreign identifiers are rejected before output, stdin or lifecycle access. Remote addressing and custom executor replacement cannot discard this restriction. Input additionally revalidates active writable assignment state; frozen or handed-off work cannot receive new stdin. Own-process inspection and cleanup remain available after those transitions.

Bash registers a physical completion promise that settles after process and artifact cleanup. Process kill/remove await that promise instead of manufacturing an early finished record. Stale-PID inspection keeps a record while registered cleanup is pending and may settle abandoned entries after that lifetime has ended. Unregistered process owners keep the existing fallback behavior. Interactive sessions retain their existing process-list scope.

## Alternatives considered

**Infer ownership from cwd.** Commands can select subdirectories and different workers can inspect the same source revision; paths do not establish Session authority.

**Hide foreign entries only in list.** A known process ID would still permit reading or mutating another worker's process.

**Treat a sent signal or missing PID as completion.** Output drain and asynchronous cleanup remain pending after the direct parent exits, and remove can otherwise race a late finished-record insertion.

## Consequences

Process ownership and completion stay in the existing in-memory registry; there is no new queue, database or migration. These records do not recover processes after host restart. They provide the attribution needed for Case lifecycle cancellation, but do not themselves implement automatic cancellation on every Case transition, workload quotas or author leases across all file tools.

The actual Oryn resolver tests cover foreign/unowned list filtering, foreign-ID rejection for all actions, own-process listing and cleanup, frozen stdin rejection, cleanup after handoff and remote denial. Process backend tests defer executor completion during kill/remove; registry tests report a missing PID while cleanup is pending and verify ownership survives final settlement. Shared Bash and process tests cover ordinary execution semantics.
