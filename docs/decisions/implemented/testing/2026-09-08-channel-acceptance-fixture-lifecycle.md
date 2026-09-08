# Decision Record: Channel acceptance fixture lifecycle

Status: implemented

## Problem

Durable Channel acceptance and eventual Session execution have different lifetimes. Acceptance fixtures used injected execution callbacks but left queued follow-up tasks available to the real scheduled wake. CI could finish all assertions while those tasks continued through a provider and wrote rollout evidence during cleanup. The [incident](../../../postmortem/0010-channel-acceptance-fixture-background-work.md) records the observed failure.

## Decision

Acceptance-only tests capture `SessionManager.scheduleWake`, preserving real inbox persistence, queue ordering, lease release and the decision to schedule. They assert the expected wake request where queued work must continue. Each fixture tracks its own Sessions, removes remaining owned inbox work, verifies idle state and restores the scheduling boundary after the test.

The dedicated release-to-steer continuation test restores real scheduling and supplies a deterministic Session loop. It waits for the inbox drain before returning. Model-driven Oryn scenarios run alongside the acceptance suite to verify restoration and preserve independent coverage of real model/tool/Boss execution.

## Alternatives considered

**Increase the test timeout.** The stray work has no intended completion in an acceptance fixture; extra time can allow more unintended provider activity and does not define ownership.

**Ignore late rollout errors.** Recording failures are valid production errors. The fixture must stop leaking work instead of weakening persistence enforcement.

**Mock the whole Channel or Session service.** That would remove the durable acceptance and ordering behavior being tested. Capture only the execution scheduling boundary in the tests that do not exercise inference.

## Consequences

The acceptance suite proves durability, ordering, duplicate handling and scheduling intent, plus one real continuation dispatch with deterministic execution. It does not prove production model reasoning or live Feishu transport. Cleanup is restricted to fixture-owned Sessions and does not reset unrelated runtime work.
