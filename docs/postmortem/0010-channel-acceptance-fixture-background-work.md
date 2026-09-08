# Channel acceptance fixtures left background work after their assertions

## Executive summary

A CI test shard reported 1866 passing tests and one unhandled error after their assertions. Channel acceptance fixtures had queued follow-up tasks that their injected callbacks never consumed. Releasing the lease let the real scheduler invoke a provider; those tasks later wrote evidence while test cleanup removed their storage. The fix defines the execution boundary and cleans up only fixture-owned work, preserving strict recording failures.

## Summary

The full CI run for Oryn commit `3b5c54fbb` failed in the core Test job. Its summary contained zero failed assertions, but the process exited unsuccessfully because of a rollout persistence error between tests. Log ordering traced the affected Session to the same-session second-message acceptance fixture. The fixture ended before its scheduled next task began.

## Timeline

- September 8: CI completed the acceptance assertions, then registered their queued Sessions again for model execution.
- Provider and rollout activity continued after the acceptance suite's success lines.
- The shard cleanup removed test storage while that work still ran; an evidence write failed and surfaced as an unhandled error.
- Local inspection identified the unused pending inbox entries and real release-time wake behind the injected execution callback.

## Root cause

The fixture equated completion of `acceptance.execution` with completion of all work in the Session. That promise only owns the direct execution. A second accepted message remains runnable, and the real release path correctly schedules it. The fake callback did not materialize or commit that follow-up. Assertion-only checks did not detect that model execution escaped the intended test boundary.

## Guardrails added

- [Acceptance tests](../../packages/synergy/test/channel/feishu-acceptance-lane.test.ts) capture scheduled wake requests for acceptance-only cases and assert the scheduling decision alongside durable inbox order.
- Fixture-owned Sessions and pending inbox messages are cleaned up before the scheduling boundary is restored.
- The release-to-steer test keeps actual scheduling with a deterministic loop and awaits its completion; adjacent model-driven QA and engineering tests verify that the override does not escape into later tests.
- The [testing guide](../../.synergy/skill/testing-guide/SKILL.md) distinguishes direct acceptance completion from quiescence of queued work.

## Lessons

A background acceptance API needs a fixture owner for every queued continuation. A green assertion summary cannot establish successful teardown when the process reports unhandled work afterward.
