# Decision Record: Verify Oryn candidate commits before acceptance

Status: implemented

## Problem

Candidate submission trusted a model-provided SHA without checking the assigned worktree. An archived or rejected candidate report could admit verification and review because stage admission searched all reports. Repeating an accepted candidate changed the Attempt revision. Separate dispatch keys could also create multiple code writers for one Attempt.

## Decision

`OrynCandidate.verify` checks the Host-bound code Assignment and Session, real worktree root, shared Git repository, assigned branch, full HEAD commit SHA, baseline ancestry and absence of tracked/untracked changes reported by Git. Configured Git filters and indexed submodules require a contained inspection environment; see [worker workspaces](2026-09-08-oryn-versioned-worker-workspaces.md). Symbolic SHA inputs, detached or changed branches, unavailable workspaces and inconsistent bindings are rejected. Read-only Git commands use bounded subprocesses, suppress hooks and fsmonitor, disable replacement objects and inherited Git configuration, and do not inherit credentials or the runtime home.

Candidate reports remain durable observations before acceptance. On an active Attempt, the Host verifies Git state, freezes the SHA and then accepts the report and delivers its Inbox event. A retry repairs acceptance after interrupted freezing and does not revise an already frozen identical Attempt. A different frozen SHA requires a new Attempt. Reports from inactive work remain historical and cannot grant stage admission.

Stage admission uses accepted reports bound to the current Case epoch and matching Assignment. Already-fixed observations do not admit coding. One Attempt has one code Assignment; repeat dispatch uses that Assignment's request key, and rework opens a new Attempt. Verification/review admission requires the accepted frozen candidate and rechecks its Git state. Delivery eligibility rechecks that same accepted candidate, so a worktree or branch changed after freezing cannot retain delivery eligibility.

No record schema changes are required. Historical model-only candidates are not promoted or rewritten; the current Git verification rejects them when they cannot be substantiated. The coder prompt states the required clean commit and unchanged candidate handoff.

## Alternatives considered

**Validate the SHA string only.** A correctly formatted SHA can refer to an absent, unrelated or different commit. The Host must check the assigned repository and branch.

**Trust any saved candidate report.** Report persistence records a model judgment, including stale or rejected work. Assignment acceptance and the frozen Attempt are required independently.

**Verify once when the worker submits.** A branch, checkout or file may change afterward. Stage admission and delivery must inspect the current candidate too.

## Verification

Temporary Git repositories and real Boss worktrees exercise nonexistent/symbolic commits, unrelated baselines, uncommitted and untracked files, branch and binding mismatches, clean commit acceptance, replay, rejected report admission and post-freeze modification. Worker-handoff tests cover archived reproduction, already-fixed observations and duplicate code writers. Existing Oryn/Boss regression covers rework, reviews, publication transport mocks and Inbox recovery.

## Consequences

Git verification establishes repository and commit consistency, not correctness of the fix or process containment. Ignored build artifacts are not proof of a source tree, and Git checks cannot make filesystem observation and later process execution atomic. A future contained executor must pin its own inputs and record actual run evidence; current executor authenticity, command profiles, receipt references, QA permissions, full policy digests and GitHub publication still require audit. No live Feishu, GitHub App or VPS deployment is demonstrated by these tests.
