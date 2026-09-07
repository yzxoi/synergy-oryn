# Decision Record: Oryn GitHub ready transition and reconciliation

Status: implemented

## Problem

Oryn's mark_ready transport only wrote an optional check run. With that flag disabled it returned success without changing GitHub, allowing a ready notification while the PR remained draft. The Host did not persist or pass the PR number for this operation, and could not reconcile a lost response. CI observation counted an empty combined-status default as pending while ignoring running check jobs.

## Decision

Use GitHub's [markPullRequestReadyForReview mutation](https://docs.github.com/en/graphql/reference/pulls#markpullrequestreadyforreview) for the actual draft transition. Read the bound PR immediately before the mutation and validate its Case marker, exact configured App login, repository, branch/base and frozen SHA. Validate GraphQL data and errors, returned identity, state and head before recording success or writing the optional oryn/delivery check. Already-ready matching PRs require no repeated transition. Failures after a write begins remain ambiguous, including network errors and malformed successful HTTP responses.

The Host permits PR updates only to Case-bound PR numbers and persists the target before dispatch. ActionReceipt schema version 2 pins the Attempt, repository, branch/base and optional-check setting; the owning migration is registered centrally and preserves old receipts without guessing missing targets. Legacy ready receipts cannot automatically finalize a candidate. Configuration or Attempt changes prevent recovery from granting a new ready result, including when two Attempts use the same SHA. Readiness reconciliation requires matching non-draft remote facts, current local evidence and any currently configured delivery check. It does not replay a remote mutation. Acknowledgement recovery restores the active candidate's ready disposition and one notification per source and attempt; old candidates and inactive Cases cannot acquire new delivery effects. Poll recovery also repairs acknowledged actions interrupted before their local effects finished.

CI observation excludes empty status collections, includes unfinished checks, reads all linked pages within a bounded limit and rejects incomplete responses. Only the configured App's own delivery check is excluded from independent CI and accepted as a delivery receipt. A matching marker or a generic bot login does not establish App ownership.

## Alternatives considered

**Treat a successful check as ready.** A check and a PR's draft state are separate GitHub facts; returning success for the former cannot establish the latter.

**Retry the mutation after a timeout.** The remote action may have committed. Observe its result and preserve ambiguity when evidence is insufficient.

**Trust any bot with the marker.** Public markers can be copied. Match the App slug obtained through the existing authenticated metadata endpoint.

## Consequences

Provider tests replace only HTTP transport and credential lookup and exercise actual request construction and response handling. Host tests use temporary Scope/storage/Git fixtures, real independent local check execution and structured review before publication. They cover persisted targets, reply loss and notification deduplication; they do not establish live GitHub App permission or real Feishu delivery.

The GraphQL mutation has no expectedHeadOid input. Pre/post head validation prevents false local acknowledgement or a check for a mismatching returned candidate, but cannot prevent a concurrent push during the remote transition. Human review and branch protection remain necessary for the current head. Full review-policy version pinning across unresolved actions, broader publish reconciliation, PR formatting/labels and the complete mock maintenance pipeline remain separate acceptance work.
