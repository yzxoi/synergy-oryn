# Decision Record: Oryn publication recovery after process death

Status: implemented

## Problem

A process can die after GitHub creates an Issue but before the transport response reaches the publication ledger. The surviving receipt remains `in_flight`, while replay returns that receipt without discovering the remote number. An engineering Session can repeatedly request the same publication without advancing. Acknowledging a receipt and attaching its remote references to the Case are separate durable writes, so interruption also leaves acknowledged receipts with missing Case links.

## Decision

Publication and reconciliation use one nonblocking publication lock per Case. A live publication excludes polling and competing publications; other Cases remain concurrent. Under that lock, orphaned `prepared` and `in_flight` receipts become `ambiguous`. Stable request replay and the GitHub poll reconciler verify remote facts without repeating the external write. Acknowledged receipts repair their Case links idempotently under the Case lock, only when the receipt epoch remains current. No persisted schema or migration changes are required.

When neither artifact number is known, the GitHub transport scans up to ten pages of repository Issues created by the configured App, including closed records. It validates the App author and exact Case marker, distinguishes Issues from PRs, rejects multiple matches of either kind and rejects incomplete pagination. It then fetches the current individual artifacts. The [GitHub repository Issues API](https://docs.github.com/en/rest/issues/issues#list-repository-issues) defines the pagination, creator filter and mixed Issue/PR response used by this implementation. Each reconciliation observation has a 30-second abort signal; three unsuccessful observations retain uncertainty and pause the Case. Labels retain their separate reconciliation owner.

The reusable test runtime starts the actual server and Agent worker pool in an isolated child process. Parent-owned loopback Feishu, model and GitHub services survive child termination. Two feedback topics run concurrently, then the fixture kills the owned runtime process group during worker model requests or after remote Issue creation before acknowledgment. A new process resumes the same durable home, keeps engineering task identities, reuses existing worker assignments when present, discovers the two original Issues and delivers correctly anchored human handoffs. Replayed inbound messages produce no additional Issues or reporter replies.

## Alternatives considered

**Blindly repeat the creation request.** A missing local response does not establish remote failure, so retrying the write can create duplicate artifacts.

**Treat every in-flight receipt as failed while polling.** A live publisher can still hold the external request. Per-Case exclusion distinguishes active execution from recoverable leftover state without another queue or database.

**Accept a marker from the first matching page.** Duplicate markers on later pages would go unnoticed. A bounded incomplete scan remains uncertain instead of choosing an artifact.

**Only seed interrupted records in the test process.** Those tests remain useful for individual ledger states but do not exercise server startup, lost IPC/model state, worker processes or simultaneous feedback ownership. The subprocess fixture covers those paths while retaining deterministic external services.

## Consequences

A crashed publication can recover through ordinary engineering Session replay or GitHub polling. The process fixture proves concurrent investigation and human-handoff recovery, including Issue acknowledgment loss; complete PR success and repair are covered separately by the existing same-process scripted pipeline. It does not prove PR delivery across process death, live Feishu subscriptions, live GitHub App permissions, VPS behavior, orphan process cleanup outside the owned group or deployment readiness. Parent coverage instrumentation does not measure code running inside child processes; direct ledger and transport tests keep those behaviors under ordinary coverage.

A repository with more than ten pages of App-created artifacts requires operator reconciliation when a number is unknown. Scanning avoids search-index freshness assumptions but costs additional read requests. Same-Case publication contention returns a retryable stage error rather than queuing a tool that could deadlock Case cancellation. Cross-process shared-home publication is outside this process-local lock's guarantees.
