# Decision Record: Oryn scripted-model QA transport fixture

Status: implemented

## Problem

The Feishu ingress fixture constructs assistant messages and invokes tools directly. It verifies routing and outbox behavior but cannot establish that the configured model receives Oryn tools or that normal model tool calls create a Case and reach the reporter.

## Decision

A reusable loopback HTTP fixture accepts OpenAI-compatible model requests and returns deterministic SSE text or function calls. Tests configure this provider through installation domains and load product registration. The ordinary ChannelHost, QA Session creation, Inbox, LLM stream, tool resolver, Case service and outbox run without substitution. The Bun test harness uses its standard in-process AgentTurn stream; this fixture does not claim worker-subprocess coverage.

The first scenario submits a bug when the approved repository directory is absent, reads the actual returned Case identity, requests human handoff and verifies the Host sends one persisted explanation. It verifies human ownership, absence of a PR, silent internal output and duplicate-event handling. The replay check waits for the existing QA task to settle and counts only QA requests, since auxiliary model work has a separate lifecycle.

The same fixture serves the OpenAI-compatible embedding endpoint, and each model scenario installs it through the embedding configuration domain. Memory recall remains real, including its recorded provider operation, but receives deterministic normalized 384-dimensional vectors derived from input bytes. These vectors carry no semantic quality claim. Scenarios assert that recall reached the fixture so a silent fallback cannot satisfy the test. Chat and embedding requests have separate bounded counters.

The fixture binds only loopback on an ephemeral port, bounds the number of successful model requests, captures protocol errors and closes its own server. Installation configuration and the original Feishu provider are restored; provider caches reload when the fixture installs or restores model configuration so a later scenario cannot reuse a closed endpoint; fixture-owned QA Sessions are cancelled, awaited and removed. It requires no production credentials or external model endpoint.

## Alternatives considered

**Continue synthesizing assistant records only.** Those narrow tests remain useful but miss provider configuration, tool exposure, model schema conversion and real tool dispatch.

**Call business services from the scenario driver.** That would reproduce the same verification gap by bypassing the tool and permission pipeline.

**Use a live model for the default fixture.** Live reasoning introduces nondeterminism, external credentials and cost. A separate authorized canary must establish model judgment and official provider delivery.

## Consequences

The scenario is repeatable with `bun run test test/oryn/model-pipeline.test.ts` from the core package and can expose runtime wiring defects beyond the service tests. The engineering scenario in `engineering-pipeline.test.ts` enters the same ChannelHost and dispatches a real Boss reproduction worker in an independent Git worktree. The scripted model proposes and executes a baseline attachment assertion through `oryn_check`, submits its actual run receipt as inconclusive evidence, and the engineering root reads the report through Inbox before handing the Case to a human. This proves baseline execution and result delivery, not a reproduced bug, candidate execution, independent review, repair or GitHub publication. Those stages require separate runtime evidence.

The `success-pipeline.test.ts` scenario starts with a failing attachment assertion and lets the code worker read, edit and commit through the product tools. Independent verification runs the identical assertion on the frozen candidate. The reviewer retrieves both receipts, then engineering calls the issue, draft, review and ready publication operations against a stateful simulated GitHub transport. Assertions cover distinct worker Sessions/workspaces, unchanged original checkout, actual baseline/candidate outcomes, accepted review, acknowledged actions and the final reporter PR link. This proves the complete scripted success branch while preserving the separate live-provider and reasoning limitations.
