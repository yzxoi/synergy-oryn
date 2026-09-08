# Oryn could edit a candidate but could not commit it

## Executive summary

A complete scripted feedback-to-PR scenario exposed a gap between the developer prompt and the autonomous sandbox. The coder could edit its assigned worktree but could not run the local Git commit required before submitting a candidate. A Host-owned commit action now prepares that candidate without granting the shell broad access to shared Git metadata.

## Summary

The test used a small attachment-forwarding repository with a real failing baseline assertion. QA intake, tracking issue creation, Boss reproduction and code assignment completed. The coder read and changed the source through the actual tools. Its shell commit failed because Git's linked-worktree metadata lived outside the writable source root. Earlier domain fixtures committed with the test runner, so they bypassed this execution requirement.

## Root cause

A linked worktree's source directory does not contain its entire writable Git state. The standard autonomous sandbox preserved the workspace write boundary while the Oryn prompt required an operation that crossed it. Tests had verified candidate acceptance after commit creation but had not made the coder create that commit through its model-facing tools.

## Guardrails added

- The [Host candidate commit operation](../decisions/implemented/bug-fix/2026-09-08-oryn-host-candidate-commit.md) validates assignment ownership and writes only the assigned branch using an expected-head update.
- Tests cover identical replay, interrupted index repair, changed replay rejection, omitted files, protected paths, wrong callers, cancellation and human takeover.
- The success scenario enters the real ChannelHost and normal model/tool pipeline. The driver does not write the fix, create the candidate commit or submit reports.
- A different worker executes the same assertion against the candidate; the reviewer reads both persisted execution receipts before its structured judgment.
- The [testing guide](../../.synergy/skill/testing-guide/SKILL.md) requires candidate preparation to run through the product tools in success scenarios.

## Lessons

An accepted candidate fixture proves validation, not that the deployed agent has a viable way to produce that candidate. Full workflow fixtures must include the operations between the tested services.
