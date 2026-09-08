# Oryn engineering mock depended on a real embedding model

## Executive summary

The model-driven engineering fixture could pass alone yet exhaust its deadline in the CI shard. Its loopback provider replaced chat inference but left memory recall using the default local embedding runtime. The mock now provides embedding responses through the normal configuration and provider path.

## Summary

After removing leaked background work from Channel acceptance fixtures, replaying the same CI shard exposed a separate engineering scenario timeout. The reproduction report had reached its engineering Session and its inbox had drained, but no next chat request arrived before the deadline. Increasing the timeout would preserve an external dependency in a supposedly deterministic fixture.

## Root cause

Diagnostic status transitions showed the QA and engineering first turns each spending about 15 seconds in memory recall before reaching the scripted chat provider. Resuming the engineering root triggered another recall. The fixture had no embedding configuration, so recall attempted to load the real local model and could fall back only after its own timeout. Shared-process state and network/model-loading progress changed the total wait.

A separate path-containment fixture used host-specific home-directory paths; a native filesystem lookup blocked the shard on macOS. That fixture now uses sibling paths under its owned temporary directory while preserving the outside-directory assertion.

## Guardrails added

- Both Oryn model scenarios configure chat and embedding against the same loopback fixture.
- The embedding endpoint returns deterministic normalized vectors and records requests separately from chat turns.
- Pipeline assertions require embedding requests to reach the fixture; unsupported endpoints and malformed requests fail the scenario.
- The runtime memory, provider recording, tool execution and Inbox paths remain active. Synthetic vectors do not establish semantic retrieval quality.
- The [fixture decision](../decisions/implemented/testing/2026-09-08-oryn-scripted-model-qa.md) and [testing guide](../../.synergy/skill/testing-guide/SKILL.md) require the complete external inference surface to be controlled.

## Lessons

A deterministic chat provider alone does not make an agent workflow deterministic. Auxiliary inference used by memory recall must also have an explicit fixture owner.
