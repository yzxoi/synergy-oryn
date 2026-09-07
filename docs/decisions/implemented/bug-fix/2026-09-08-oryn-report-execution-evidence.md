# Decision Record: Validate execution evidence before accepting Oryn worker claims

Status: implemented

## Problem

A worker could report a reproduced bug without running a check, or attach unknown and foreign run IDs. Coding admission trusted the accepted report's outcome string. Delivery accepted any passing candidate process without requiring an independent verifier's accepted report. These paths allowed model claims to advance work without attributable execution evidence.

## Decision

The Oryn evidence owner validates every run reference before a current worker report is accepted or delivered to the engineering Inbox. A receipt must belong to the reporting assignment, Case and Attempt, match the expected source SHA and a current approved plan, and carry a source tree digest. Plan identity includes its scenario, profile, command arguments and assertions; profile and overlay declarations must also match the receipt.

Reproduced and already-fixed reports require the worker's own clean baseline failure and success respectively. A successful verification report requires the verifier's own clean candidate success. An infrastructure failure or experimental lane cannot prove reproduction. Inconclusive reports may carry no runs so missing environments can still reach a human. Stale reports remain archived without acceptance or notification.

Coding admission rechecks accepted reproduction evidence, including older Attempts used for bounded rework. Delivery requires valid accepted reproduction evidence for bug cases and a successful independent verifier report on the current Attempt. A passing process alone cannot satisfy that verifier requirement. Existing records are not rewritten or promoted: an old accepted report without valid evidence cannot admit coding or delivery under these checks.

## Alternatives considered

**Trust a completed Boss report.** Task completion and a model's outcome string do not identify an actual run or prove that it belongs to the reporting worker.

**Check only that run IDs exist.** Another assignment or source version could supply an unrelated success or failure.

**Require evidence for every report.** Environment gaps need an honest inconclusive report even when no process can run.

## Consequences

Behavioral tests cover missing and foreign references, source/version mismatches, infrastructure and experiment results, plan changes after acceptance, report delivery, and coding admission. Success fixtures execute small real baseline processes through the actual sandbox and scheduler. The delivery test remains blocked after a candidate process passes until its independent verifier submits a matching report.

These checks establish receipt ownership and report dependencies. They do not establish that an arbitrary command exercised the reported user behavior, validate build provenance, snapshot the complete execution policy, or replace independent review. The executor's authenticity classification and complete content-based policy/evidence versioning remain separate work. The fixture commands exercise this ownership logic and are not a live Feishu acceptance test.
