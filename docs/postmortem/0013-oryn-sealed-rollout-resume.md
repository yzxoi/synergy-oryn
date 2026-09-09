# Oryn recovery queued a new task but reopened a sealed rollout

## Executive summary

An Oryn deployment canary remained queued after human resume. The Host could enqueue a fresh root, but the Session loop read the previous root's execution configuration before consuming that task. The previous rollout was terminal, so execution failed before the new task materialized. A test that manually materialized the Inbox item passed and concealed the gap. Recovery verification must drive the real Session loop through result submission.

## Summary

The canary had preserved an aborted engineering conversation and older recovery steering. Resume also attempted to wake that conversation before GitHub review versions were assigned. Separately, fetching into an empty temporary Git repository discarded the existing trusted object cache and could spend the fetch timeout downloading repository history again. Health checks and schema migration both passed while useful work stayed blocked. Once recovery resumed, the live diverged PR exposed a downstream admission guard still comparing its baseline with the target tip instead of the assigned merge base.

## Timeline

On 2026-09-09, fixed-commit dependency installation passed on the Linux deployment. A resumed PR still showed no execution time. Runtime diagnostics identified a terminal-rollout append failure and delayed GitHub source preparation. Replacing manual Inbox materialization in the regression fixture with actual Session wake reproduced the failure. The corrected loop consumed the queued new root and submitted a structured report while preserving the old terminal record.

## Root cause

The original recovery test checked storage transitions instead of scheduler consumption. Creating a task does not prove that the loop selects it before touching old execution state. The old GitHub resume path also granted execution before the current review fingerprint was assigned. Fetch isolation protected credentials but omitted object negotiation reuse, conflating private configuration with an empty object database.

## Guardrails added

[Worker recovery tests](../../packages/synergy/test/oryn/worker-start.test.ts) now execute the actual configured model transport and result tool after a sealed rollout. The Session loop consumes a queued new task before configuring a terminal predecessor. [GitHub runtime tests](../../packages/synergy/test/oryn/github-runtime.test.ts) require pinned admission before a bound review Session can run. [Fetch tests](../../packages/synergy/test/channel/provider/github/oryn-fetch.test.ts) require cached commits to be pinned without another credential request or history download. The GitHub admission fixture now creates diverged target and contributor histories and dispatches a real reviewer worktree, so the producer and consumer must agree on the merge base. The [pipeline decision](../decisions/implemented/architecture/2026-09-09-oryn-pipeline-runtime.md) records the resulting behavior.

## Lessons

Validate the consumer of durable work, not only its producer. A healthy listener and successful migrations are prerequisites, not end-to-end acceptance. Git configuration isolation and object-cache reuse are compatible and should be tested separately.
