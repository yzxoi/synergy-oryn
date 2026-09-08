# Decision Record: Label tracked contributor work with emoji metadata

Status: implemented

## Problem

The original label transport required App authorship and an Oryn Case marker. Existing contributor Issues and PRs therefore remained unlabeled even after Oryn admitted and reviewed them. Plain label identifiers also gave operators little visual distinction between type, progress and priority.

## Decision

The Host grants label-only access to a current GitHub work record under its installation repository/account binding. It includes external PR numbers even before an engineering Attempt exists, pins their observed head and base branch, and rechecks Case control, source fingerprint and target projection before each write. The provider checks the open object and repository identity; contributor branches and fork authorship do not need to match the App. Objects outside this tracked path retain the original App-author/marker/branch checks described in [owned label projection](../architecture/2026-09-08-oryn-github-label-projection.md).

Draft and review-disabled PRs may have durable label records without engineering admission. External PR progress distinguishes queueing, active review and completed review awaiting human attention. It never certifies delivery. Existing enhancement/question labels and conventional feature/performance titles provide display-type hints; they do not grant execution authority or change Case acceptance.

The shared label catalog maps stable canonical IDs to emoji names, colors and descriptions. Persisted action receipts and schema versions are unchanged. The provider recognizes canonical legacy names and current emoji names, adds the current display names, and removes only the actual matching type/status names. Priorities and unrelated labels remain untouched. The existing bounded action ledger handles interruption and replay.

GitHub writes follow the [add/remove label API](https://docs.github.com/en/rest/issues/labels); replacement of the entire label list remains forbidden.

## Alternatives considered

**Keep labels restricted to App-created artifacts.** This leaves the existing repository backlog invisible to operators even though engineering is already handling it.

**Allow any model-selected repository number.** This loses the installation binding and durable Case ownership checks. Label authority is derived by the Host instead.

**Replace persisted IDs with emoji names.** Presentation changes would require rewriting action history and deduplication keys. A shared display catalog keeps history stable.

## Consequences

Operators must create the catalog's GitHub label definitions and explicitly enable labels. Active open work is synchronized through the bounded repository poll. Paused, taken-over, cancelled and closed Cases receive no new writes. A completed external review's ready label means human attention is next, not that the PR passed the owned-candidate delivery gate.

Tests cover tracked Issue/PR projection, draft admission, binding revocation, foreign author rejection outside the tracked path, changed heads, emoji convergence, legacy/emoji priority preservation and interrupted action migration. Transport fixtures do not prove live repository permissions; deployment verifies real label definitions and remote applications separately.
