# Decision Record: Project Oryn progress through owned GitHub labels

Status: implemented

## Problem

Oryn Case progress and priority were absent from GitHub issue/PR labels. Model-authored labels could disagree with the accepted candidate, replace human triage, or become an unintended source of execution authority.

## Decision

An installation-owned repository opt-in enables a deterministic label projection. Type comes from Case kind; progress comes from the active Attempt and current-epoch Assignments. Missing priority is explicitly untriaged unless the operator configures an initial priority. Any existing priority label is preserved. The model publish tool cannot invoke label synchronization or supply arbitrary label mutations. Reused request keys must match the original operation, so a label receipt cannot acknowledge a different publication request.

The existing GitHub poll runs a bounded rotating Case scan with a non-queuing overlap guard. The provider validates the exact App login, Case marker, object type and candidate branch/base/head, reads paginated labels and rechecks Host authorization before each mutation. It uses add/remove endpoints following the [GitHub label API](https://docs.github.com/en/rest/issues/labels), never the replace-all endpoint. Known type/status labels are managed; unrelated labels and priorities are preserved.

ActionReceipt schema version 3 stores a fixed label target. The centrally registered migration upgrades version 2 without inventing label intents and preserves earlier readiness targets. Prepared/in-flight/ambiguous actions reconcile against remote facts. Remaining deltas can be retried at most three times for one unsettled projection; label failures do not pause engineering. Local supersession stops an old intent without claiming rollback of already-sent writes. Cases under human control receive no new label mutations.

## Alternatives considered

**Let each agent manage labels.** That introduces stale or contradictory progress and exposes unnecessary remote-write authority.

**Replace the complete label list.** Concurrent human or third-party labels could be lost. Individual owned additions/removals preserve them.

**Use labels as a workflow queue.** Session/Inbox and the existing Case records already own execution. Labels remain a derived external display.

## Consequences

Behavioral tests cover projection, known-label ownership, human priority beyond page one, exact App identity, pre-write takeover, lost-response and in-flight recovery, bounded failure and fresh/legacy migration. The network is mocked. Label definitions and live App scopes remain deployment setup, documented in the runbook. Temporary mixed stage labels can occur between individual GitHub requests; readiness continues to depend on delivery evidence and checks, not label text.
