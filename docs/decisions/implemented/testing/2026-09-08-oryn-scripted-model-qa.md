# Decision Record: Oryn scripted-model QA transport fixture

Status: implemented

## Problem

The Feishu ingress fixture constructs assistant messages and invokes tools directly. It verifies routing and outbox behavior but cannot establish that the configured model receives Oryn tools or that normal model tool calls create a Case and reach the reporter.

## Decision

A reusable loopback HTTP fixture accepts OpenAI-compatible model requests and returns deterministic SSE text or function calls. Tests configure this provider through installation domains and load product registration. The ordinary ChannelHost, QA Session creation, Inbox, LLM stream, tool resolver, Case service and outbox run without substitution. The Bun test harness uses its standard in-process AgentTurn stream; this fixture does not claim worker-subprocess coverage.

The first scenario submits a bug when the approved repository directory is absent, reads the actual returned Case identity, requests human handoff and sends one explicit explanation. It verifies human ownership, absence of a PR, silent internal output and duplicate-event handling. The replay check waits for the existing QA task to settle and counts only QA requests, since auxiliary model work has a separate lifecycle.

The fixture binds only loopback on an ephemeral port, bounds the number of successful model requests, captures protocol errors and closes its own server. Installation configuration and the original Feishu provider are restored; fixture-owned QA Sessions are cancelled, awaited and removed. It requires no production credentials or external model endpoint.

## Alternatives considered

**Continue synthesizing assistant records only.** Those narrow tests remain useful but miss provider configuration, tool exposure, model schema conversion and real tool dispatch.

**Call business services from the scenario driver.** That would reproduce the same verification gap by bypassing the tool and permission pipeline.

**Use a live model for the default fixture.** Live reasoning introduces nondeterminism, external credentials and cost. A separate authorized canary must establish model judgment and official provider delivery.

## Consequences

The scenario is repeatable with `bun run test test/oryn/model-pipeline.test.ts` from the core package and can expose runtime wiring defects beyond the service tests. The initial fixture proves environment handoff, not reproduction, candidate execution, independent review, repair or GitHub publication. Those stages must be added as real runtime paths with explicit evidence rather than inferred from this result.
