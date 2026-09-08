# Decision Record: Recoverable Oryn engineering startup

Status: implemented

## Problem

Feishu QA submission could persist a Case without starting its engineering Boss session. Creating a Session alone would still leave the Case idle because Boss roots require an Inbox event. Retrying interrupted multi-record creation could duplicate identities or overwrite canonical records before their indexes and Case links were complete.

## Decision

`OrynEngineering` owns the startup operation. A per-Case lock serializes it, and a version 1 `engineering_start` record reserves the Session and initial Attempt identities before creation. The operation freezes the repository directory, Scope and baseline, creates an autonomous unattended `oryn-work` Boss root, preserves its source binding, delivers one initial task with a durable key and requests the ordinary Session wake path. No additional execution queue or model polling loop is introduced.

Repository configuration has an optional `directory` field for a trusted, pre-fetched checkout. Automatic startup requires an absolute canonical Git root with the configured GitHub origin and a reachable baseline commit. `workRoot` is not a checkout and the QA Scope is not a fallback. Missing setup records a blocked reason; submission distinguishes durable acceptance from engineering startup. Case reads expose the startup state and reason without exposing its directory.

The initial baseline comes from the configured origin tracking branch, unless an existing startup or Attempt already fixed it. Read-only Git probes have time and output bounds and disable global configuration, hooks and filesystem monitors. Startup does not fetch, switch branches or reset the configured repository. The root uses its explicit repository workspace rather than inheriting the QA workspace. Its files are not a frozen execution sandbox; isolated candidate execution remains a separate requirement.

`Session.recoverCreation` repairs projections from existing canonical Session info under the Session mutation lock. It refuses a conflicting identity and preserves content and creation time. The Oryn owner does not reconstruct Session indexes itself or overwrite existing Session info. A reserved initial Attempt that exists before its Case link is repaired without rewriting the Attempt. These are interrupted current-writer operations, not schema migrations or legacy backfills.

Before initial Inbox delivery, startup acquires the Case control lock and rechecks control and epoch. A cancellation during creation therefore leaves no initial runnable task. Runtime startup retries active Cases, resumes pending creation and wakes already-started Sessions with runnable Inbox work. A consumed initial task is not redelivered. Completed startup also settles incomplete intake claims. Individual recovery failures are counted and logged without raw repository errors; malformed startup records remain errors rather than disappearing as missing data.

## Alternatives considered

**Create a fresh Session when lookup fails.** Lookup may fail because creation stopped before the index write. Recreating it overwrites canonical content or makes the earlier record unreachable. Persisted identities and owner-managed index recovery preserve the existing work.

**Start from the QA directory or the first configured repository.** Neither identifies the authorized engineering checkout. Explicit repository mapping and origin checks make missing deployment setup visible.

**Run a new coordinator loop.** Boss and SessionInbox already schedule durable work. Startup requires a recoverable business operation and an initial Inbox event, not another execution service.

## Consequences

Local behavior tests cover duplicate concurrent submission, interrupted Session indexing, interrupted Case and Attempt linkage, a moved tracking branch, consumed Inbox replay, origin mismatch, cancellation and startup-status reads. Session tests separately cover content preservation, repeatable recovery and conflicting Scope indexes. These tests use temporary repositories and leased Sessions; they do not call a live model or prove Feishu delivery, worker execution isolation, GitHub publishing or VPS deployment.

The operation currently starts Feishu-origin Cases. Configuration changes need another submission or runtime restart to retry blocked setup. Complete worker-creation recovery, structured review wakeup, trusted execution, GitHub lifecycle handling and the full mock pipeline remain separate integration work. This change does not make the whole product deployment-ready.
