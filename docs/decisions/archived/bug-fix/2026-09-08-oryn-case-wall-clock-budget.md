# Decision Record: Enforce Oryn Case wall-clock budgets

Status: implemented
Archived: 2026-09-09

## Problem

The configured Case time budget was checked only before an explicit check run and only when a limit was supplied. Engineering/model work and ordinary coder shells could continue beyond it, the documented default was unenforced, and exhaustion did not generate the promised human handoff.

## Decision

A shared Oryn budget policy derives expiry from the persisted Case creation time and the installation limit, defaulting to 720 minutes. It guards Session execution, engineering dispatch, check execution and publication. A ready Attempt awaiting human review is exempt from automatic expiry. Repair, restart and pause/resume preserve the original time budget.

The server owns a budget monitor with a startup sweep before pending Session resume and a one-second delay between subsequent sweeps. The monitor uses existing Case control, Session cancellation/drain, ProcessRegistry termination and outbox recovery. It has no durable task queue or model-based coordinator. Handoff records become authoritative before cancellation, and cleanup failures request another recovery pass. Notification recovery is tracked separately so a pending provider response does not block enforcement of other Cases.

Conditional handoff compares the observed Case and Attempt revisions while holding the Case lock. A stale observation cannot take ownership from a concurrently completed Attempt. The change adds no persisted schema and does not backfill timestamps.

## Alternatives considered

**Check only when a build or test starts.** This does not cover ordinary inference, coding tools or an already-running process.

**Reset time on every repair or ownership resume.** Repeated rounds or restarts could extend autonomous execution indefinitely.

**Deliver the notification inline with the sweep.** Provider latency would delay cancellation of other expired Cases. The existing durable outbox already owns delivery identity and uncertainty.

## Consequences

Tests exercise expired admission, configured and default limits, active Session cancellation, actual background-process termination, QA availability, one handoff per Case across monitor restart, publication denial and a completion race. Holding the first reporter send does not prevent a second Case from expiring or receiving its own result after delivery resumes. Existing active Cases are evaluated against their original creation times on upgrade; operators must select the installation budget before resuming preserved work.

This is wall-clock enforcement, with event-loop detection and physical-cleanup latency. It is not model-token accounting, a worker concurrency quota or a CPU/memory limit. Completed ready Attempts are not automatically converted to handoffs while humans consider merging.
