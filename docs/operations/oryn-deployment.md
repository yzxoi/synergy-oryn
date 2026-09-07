# Oryn Deployment Runbook

This runbook covers deploying the Oryn feedback-to-PR runtime on a single Linux host: environment preflight, channel test-app setup, minimal GitHub App scopes, quotas, silent-notification behavior, delivery-check gating, and backup/recovery. All identifiers, paths, and IDs in this document are placeholders — substitute per-deployment values and never commit real secrets, chat IDs, or account IDs.

Oryn is dormant unless `oryn.enabled` is `true`. Every preflight step below assumes a stock Synergy deployment already runs successfully; if the baseline runtime is unhealthy, fix that first — Oryn does not debug the host it runs on.

Oryn authorization must be configured in the installation-owned `120-runtime.jsonc` domain. Project-local configuration and scoped overrides do not authorize Oryn repositories, execution profiles, publication or budgets. Do not copy a candidate repository's configuration into the installation. Configure model roles through installation model settings; Oryn agent IDs, prompts and role definitions are reserved. See [installation policy](../decisions/implemented/architecture/2026-09-08-oryn-installation-policy.md) for the enforced scope and remaining execution checks.

Worker source separation is covered by [versioned-workspace tests](../decisions/implemented/architecture/2026-09-08-oryn-versioned-worker-workspaces.md). Every new worker needs enough disk for a worktree; repro/code pin baseline and verify/review pin candidate. Historical main-checkout workers must be stopped and replaced, not rebound while active. Git filters, submodules and dirty overlays require a contained execution path that is not delivered by these checks. Broader resource accounting, build/experiment staging and full pipeline validation are still required before this runbook can be treated as deployment acceptance.

The shared check runner bounds output and manages ordinary Unix descendants, as described in [check process lifecycle](../decisions/implemented/bug-fix/2026-09-08-owned-check-process-lifecycle.md). Checks use an explicit sandbox policy with read-only source, private disposable HOME/temp paths and restricted networking; see [check containment](../decisions/implemented/bug-fix/2026-09-08-oryn-check-containment.md). Check-heavy and profile limits now use [ToolScheduler resource admission](../decisions/implemented/architecture/2026-09-08-oryn-check-resource-admission.md); these counters do not yet include coder Bash/background processes or reserve QA model capacity. This check-only isolation does not establish containment of ordinary coder Bash or complete deployment acceptance.

## Engineering Checkout and Startup

Automatic Feishu Case startup requires `oryn.repositories[alias].directory` to name an absolute, trusted, pre-fetched local checkout. Its canonical directory must be the Git root, its `origin` must match the configured GitHub owner/repository, and `refs/remotes/origin/<baseBranch>` must resolve to a commit. Prepare or fetch that checkout through the authorized deployment workflow before enabling intake. `workRoot` is a container for worker directories and does not replace this checkout.

Case submission returns separate acceptance and engineering startup results. Missing or mismatched setup leaves a durable blocked reason visible through `oryn_case` get; it does not use the QA directory. Correct the setup and resubmit the same request or restart the dedicated test runtime to retry. Startup preserves its reserved Session/Attempt and baseline across retries; it does not switch or reset the checkout. The engineering root reads that configured checkout, so keep it under operator control; this path does not yet provide frozen candidate execution.

Run `bun test test/oryn/engineering-start.test.ts test/session/creation-recovery.test.ts` from `packages/synergy` to verify creation interruption, replay, origin validation and cancellation against temporary repositories. It holds Session leases to avoid invoking a live model. The full execution and publishing pipeline remains under integration review; this runbook is not yet evidence of a production-ready deployment.

## Isolation Preflight

`oryn_check` defaults to local `sandbox` isolation. Explicit `worktree` and `external_vm` execution are rejected: directory separation is insufficient and no VM execution transport is connected. macOS uses a deny-default Seatbelt profile; Linux requires the built helper and Bubblewrap with usable user/PID/network namespaces and seccomp. A missing or rejected wrapper cannot fall back to an unwrapped command, regardless of ordinary interactive sandbox fallback settings.

The local check profile exposes the pinned source read-only, plus system executables/libraries and the approved executable. Each command gets a private, disposable HOME and temporary directory; token, SSH agent, provider, proxy and language injection variables are absent. Host network access is denied. Commands needing source writes, dependency downloads, persistent build outputs or a browser need a separately implemented execution profile; do not interpret their environment failure as a reproduced bug.

| Declared capability                          | Local check behavior                                                                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `namespace`, `seccomp`                       | Accepted only on Linux; actual helper startup must succeed. These checks do not establish cgroup or separate host-UID isolation. |
| `uid`, `cgroup`, `browser`, `network_egress` | Rejected as unavailable. The runtime does not currently provide these capabilities for checks.                                   |

Run `bun test test/oryn/sandbox.test.ts test/oryn/workspaces.test.ts test/sandbox/explicit-profile.test.ts` from `packages/synergy`. Native Linux execution needs the locally built helper installed in the sandbox helper search path and Bubblewrap. The dedicated Oryn Native Containment workflow provisions these on an ephemeral Linux VM without Docker. Native macOS checks, Linux native checks and compiler/serialization assertions are distinct evidence; inspect the workflow result for the exact commit before treating Linux execution as validated.

The ordinary coder Bash path has separate credential injection and process permissions. This runbook does not yet establish its credential isolation; the check runner's exact environment must not be generalized to every worker shell. If the required execution capability is unavailable, preserve the Case for human intervention rather than changing to `full_access`.

### Ubuntu namespace policy

On Ubuntu hosts that restrict unprivileged user namespaces, install the distribution's current Bubblewrap and AppArmor packages and have the administrator verify that an approved `bwrap-userns-restrict` profile is loaded. Ubuntu 24.04 packages may omit this optional profile; the CI setup retrieves the [AppArmor 4.0.3 profile at a fixed commit](https://gitlab.com/apparmor/apparmor/-/blob/b4dfdf50f50ed1d64161424d036a2453645f0cfe/profiles/apparmor/profiles/extras/bwrap-userns-restrict) and verifies its SHA-256 before installation. That profile permits Bubblewrap setup while restricting child capabilities; use the reviewed profile rather than disabling AppArmor or its system-wide namespace restriction. See [Ubuntu's explanation and profile guidance](https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007). If host policy forbids namespaces, retain the environment failure and route the task to an authorized environment or a human.

Before starting candidate work, verify the actual helper through the native Oryn tests. `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted` is a sandbox startup failure, not a reproduced application bug. The CI-only `script/prepare-linux-test-sandbox.sh` provisions disposable GitHub-hosted VMs, loads the approved profile when namespace restrictions are enabled, and probes network namespace startup. It refuses ordinary deployment hosts; production setup remains an administrator operation.

## Network and Ports

- Run the Synergy server on its own port behind the deployment's reverse proxy; Oryn adds no new listening port.
- Check subprocesses have no host network access. Feishu, GitHub and model connections belong to the runtime; installing dependencies and network-dependent tests need separate, authorized execution support.
- Feishu and GitHub callbacks follow the existing Channel provider requirements; Oryn adds no additional inbound webhook endpoint (GitHub observation is poll-based).

## Channel Test Apps

The local mock ingress check needs no Feishu credentials. From `packages/synergy`, run `bun test test/oryn/feishu-ingress.test.ts test/oryn/outbox.test.ts test/oryn/tools.test.ts`. It enters the real ChannelHost, persists Inbox tasks, executes the reply tool and sends through a captured provider. It verifies thread/reply routing and uncertain dispatch with synthetic assistant output. It does not prove live Feishu delivery, model behavior, candidate execution, or GitHub publication; those require separate evidence.

### Feishu

1. Create a dedicated test tenant app (placeholder name `oryn-test-app`); do not point Oryn at a production bot.
2. Grant the minimal IM scopes needed by the existing Channel provider (receive group/DM messages, send messages, read thread metadata).
3. Configure one account entry under `channel.feishu.accounts` and reference that account ID from `oryn.routes[].feishuAccount`.
4. Set `groupSessionScope` to `group_thread` on the Oryn-bound account so each topic gets its own QA session; other accounts keep their existing scoping.
5. Set a non-empty `oryn.routes[].chats` allowlist to restrict intake to the intended test chats. An omitted or empty `chats` list matches the whole configured account; it does not disable intake. Accounts without a matching Oryn route keep ordinary Synergy routing.

### GitHub App

Minimal permissions for the Oryn publish transport:

- **Contents: read & write** — push the frozen candidate to the `codex/oryn/<public-token>` branch and read refs.
- **Issues: read & write** — create the case tracking issue and automation comments.
- **Pull requests: read & write** — open the draft PR, update it, and post the review comment.
- **Commit statuses: read** — observe CI on the candidate.
- **Checks: write** — write the `oryn/delivery` check run (see the gating section below).

Do not grant Administration or protection-bypass privileges. GitHub does not provide an independent deny-merge permission alongside these write permissions; human review requirements and the Host operation allowlist must enforce the merge policy. Oryn exposes no merge or release operation.

Install the App on the target repositories (placeholder `owner/repo`), set the app credentials in the runtime environment (`SYNERGY_GITHUB_APP_ID`, `SYNERGY_GITHUB_APP_PRIVATE_KEY`), and confirm `resolveInstallation` succeeds before enabling `oryn.repositories`.

## Configuration Checklist

Enable Oryn only after all of the following hold:

- `oryn.enabled: true` with at least one `routes` entry and one `repositories` entry (the schema rejects enabling without them).
- `oryn.repositories[alias].baseBranch` points at the branch PRs target (for this fork's workflow: `dev`).
- `oryn.executionProfiles` declare only capabilities the preflight verified.
- Set `oryn.limits.heavyConcurrency` for check processes (runtime default 2) and explicit `maxCaseMinutes` for check admission. Full worker-count, model-token and runtime-wide Case budget enforcement remain incomplete; the schema descriptions are not proof of enforced limits.
- `oryn.review.maxRepairRounds` (default 3) and `maxNoProgressRounds` (default 2) reflect the team's appetite for autonomous rework.
- Project-level config does not override runtime-owned Oryn keys; the `runtime` domain owns this key and project config cannot widen the allowlists.

## Quotas and Silent Notifications

- Every stage dispatch, worker report, review, and check run is a durable record; the Feishu reporter receives only the six result kinds (`answer`, `clarification`, `accepted`, `needs_human`, `ready`, `released`) filtered by `oryn.notifications.kinds`. Process noise (tool calls, worker reports, retries) is never delivered.
- Reply intents deduplicate by recipient and operation. Answers and clarifications are scoped to the host-owned root turn, so later questions can receive answers. Before transport invocation, the outbox records an uncertain dispatch; a confirmed response settles it to delivered. Timeout or interruption does not trigger an automatic resend. Draft PR creation, merge, and release are distinct facts.
- Check admission rejects an explicitly configured Case wall-clock limit once exceeded. Model-token accounting, automatic budget handoff and ordinary coder-shell accounting still need implementation and verification; do not rely on the corresponding configuration fields as hard limits.

## Delivery Check Gating

Worker completion does not imply verified behavior. Reproduction and verification claims must reference the reporting assignment’s actual runs, with matching source and approved plan; delivery requires an independent verifier report. Environment failures remain inconclusive. See [report evidence validation](../decisions/implemented/bug-fix/2026-09-08-oryn-report-execution-evidence.md) for the guarantees and remaining authenticity limits.

The `oryn/delivery` check run is written only when `oryn.repositories[alias].deliveryCheck` is `true` (default `false`). Follow this sequence when turning it on:

1. On an explicitly authorized test repository, enable `deliveryCheck: true` while leaving the check out of branch protection. With the flag false, no check is written and a canary cannot verify it.
2. Exercise the gated publication path and verify the check appears on the candidate SHA under the expected App identity. Verify the same PR becomes ready for review. The transport performs the GraphQL Draft-to-ready transition independently of the optional check flag, validates the returned candidate, and only then writes the enabled check.
3. After complete pipeline acceptance, enable the check for the target repository and register it as required with the expected App identity if branch protection requires it.

Never register `oryn/delivery` as a required check before the deployment has observed it run for real; a required check that the App cannot write blocks every PR on the branch.

Readiness is tied to a Case-owned PR, frozen candidate SHA, branch/base and the configured App identity. The publisher records the PR target before dispatch. A lost response is reconciled from the remote non-draft PR and, when enabled, its App-owned delivery check; unresolved or changed candidates pause instead of replaying writes. Successful settlement restores the attempt outcome and deduplicated per-source notifications after interruption. CI observation includes pending checks and paginated check results; the App's own delivery check is excluded from independent CI.

GitHub's ready mutation has no expected-head parameter. The transport checks the head before and in the mutation result, but it cannot make the remote transition atomic with concurrent pushes. Required checks and human review must remain tied to the current head. Publication receipts pin the Attempt and repository/base/check settings; changes leave unresolved actions for reconciliation. Full review-policy changes during unresolved publication still need operator reconciliation; this is not a claim that the remaining pipeline acceptance work is complete.

## Backup and Recovery

Oryn JSON records live under `$SYNERGY_HOME/.synergy/data/oryn/`. `SYNERGY_HOME` is the parent home; the runtime appends `.synergy`, as defined in [Storage and paths](../reference/storage-and-paths.md). The logical storage keys are:

- `oryn/cases/**` — cases, attempts, assignments, runs, reviews, reports.
- `oryn/actions/**` — the external action ledger (authoritative for reconciliation).
- `oryn/claims/**`, `oryn/sources/**`, `oryn/outbox/**` — intake and delivery state.
- `oryn/session_source/**` — host-owned session bindings.

Outbox schema version 2 distinguishes definitely unsent `pending` entries from `ambiguous` dispatches. The central upgrade migration preserves confirmed receipts and marks old pending entries ambiguous because their send history is unknown. Do not reset ambiguous entries to pending during recovery; first obtain authoritative provider evidence or reconcile manually. The older binary cannot safely read these delivery semantics; a rollback needs a consistent pre-upgrade backup and review of any subsequent remote writes.

Use a consistent backup of the dedicated runtime root, including its `data/` and configuration, with the same cadence as the rest of the runtime. Oryn does not have an independent transactionally consistent backup. Recovery rules:

- After a crash, intake claims and the action ledger make every step resumable: replayed submissions dedupe to the same case, and ambiguous external actions settle through reconciliation against remote facts (App author, case marker, head SHA) instead of blind replay.
- Never restore a partial `oryn/` subtree alone; restore the storage directory as a unit so ledger, claims, and case records stay consistent.
- Session bindings reference session IDs; restoring data without the sessions directory leaves orphaned bindings, which the host treats as unbound (fail-closed) rather than re-binding automatically.

## Disable and Rollback

Set `oryn.enabled: false` (or remove the `oryn` key) and restart the runtime. Disabled behavior is a product invariant: no Oryn agents, tools, routes, or poll additions execute, and ordinary Channel/Boss/Feishu/GitHub behavior is unchanged. In-flight external actions recorded before the flip are reconciled on the next enabled window; a case left mid-flight stays paused-safe and requires a human to resume.
