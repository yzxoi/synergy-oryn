# Decision Record: Exercise Oryn PR delivery across runtime death

Status: implemented

## Problem

Same-process success and repair tests do not prove that persisted candidate evidence, review history and publication receipts can resume after the runtime dies. The existing child-process scenarios end in human handoff, so they do not cover PR creation, candidate refresh or readiness with a lost acknowledgment.

## Decision

A reusable attachment scenario drives QA, engineering, reproduction, coding, verification and review through the configured model transport and actual product tools. Its next action derives from model-visible tool-call results rather than in-memory dispatch, publication or coding counters. The same script serves the original success tests and the separate-process recovery tests, and is recreated after each runtime death.

The parent process owns only simulated model, Feishu and GitHub transports plus inspection commands. A child starts the real server and Agent worker pool in an isolated home. It receives Feishu feedback, reproduces a failing attachment assertion, changes code through the write and Host commit tools, and obtains independent candidate verification and structured review. The parent holds the GitHub response after applying draft creation, PR refresh or readiness, records the in-flight receipt and then kills only that child process group. The replacement runtime opens the same durable home and must reconcile the remote fact without executing the write again.

The repair scenario rejects a candidate that aliases the caller's attachment array, retains the failed receipt and open finding, rotates the Attempt, and verifies a corrected copy. After interruption during the corrected PR refresh, the same PR must reach readiness with the prior finding resolved and the addressed-finding link retained. A further process restart after completion must preserve all action, Attempt and Assignment identities and send no additional notification.

The snapshot protocol exposes existing Attempts, execution receipts, reviews and worker reports alongside Cases and Sessions. This is test inspection over IPC, not a new product API or persistence owner. Linux child homes receive only the source-built sandbox helper when available; no credentials or general parent environment are copied. The PR scenario disables optional LSP diagnostics and formatter startup, while retaining actual code editing, contained Bun execution, Host commits and independent evidence gates.

## Alternatives considered

**Reset modules in the existing test process.** This preserves process-local runtime state and cannot exercise server startup, Agent worker creation or process death.

**Construct reports directly in the test driver.** This would bypass model-visible tools, assignment authorization, candidate preparation and real baseline/candidate execution.

**Preserve mock model counters across restart.** Such counters could advance a test despite missing durable tool results. The shared script reads the supplied conversation history and uses stable publication request keys for replay.

## Consequences

The scenarios verify one Issue and PR, exact frozen SHA, separate worker Sessions/workspaces, preserved roots across restart, acknowledged publication receipts, actual failed baseline and passing candidate, independent review, one final reporter link and no progress noise. The repair branch additionally verifies two Attempts, one repair round, retained open/resolved findings and one PR identity. The native Linux CI suite includes these tests without Docker.

GitHub facts and model judgment remain deterministic simulations. The Git transport's separate real push/receive-pack tests and GitHub adapter's HTTP tests provide their own narrower evidence. These process scenarios do not prove live provider authentication, arbitrary interruption during every tool, recovery of escaped OS processes or all future repair paths. They extend the [publication recovery](../bug-fix/2026-09-08-oryn-publication-crash-recovery.md) evidence without treating mock success as deployment acceptance.
