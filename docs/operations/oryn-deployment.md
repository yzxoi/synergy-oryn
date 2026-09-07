# Oryn Deployment Runbook

This runbook covers deploying the Oryn feedback-to-PR runtime on a single Linux host: environment preflight, channel test-app setup, minimal GitHub App scopes, quotas, silent-notification behavior, delivery-check gating, and backup/recovery. All identifiers, paths, and IDs in this document are placeholders — substitute per-deployment values and never commit real secrets, chat IDs, or account IDs.

Oryn is dormant unless `oryn.enabled` is `true`. Every preflight step below assumes a stock Synergy deployment already runs successfully; if the baseline runtime is unhealthy, fix that first — Oryn does not debug the host it runs on.

## Isolation Preflight

Oryn executes untrusted repository code through its execution profiles. Before enabling the runtime, verify each capability a profile declares (`oryn.executionProfiles.<id>.requiredCapabilities`):

| Capability       | Check                                                                                                                         | Fail-closed behavior                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `uid`            | The service user is a dedicated non-root UID (`id <service-user>`); worker processes must not run as the runtime user's login | Profile is rejected at run time; the case reports the gap and requests a human     |
| `namespace`      | `unshare --user --map-root-user true` succeeds for the service user                                                           | Same as above                                                                      |
| `seccomp`        | The kernel exposes seccomp filtering (`/proc/self/status` shows `Seccomp:`) and the bundled sandbox backend launches          | Falls back per `sandbox.fallbackPolicy`; `deny` is required for untrusted profiles |
| `cgroup`         | A writable cgroup subtree exists for memory/CPU limits                                                                        | Profile rejected                                                                   |
| `browser`        | A headless browser launches in the worker environment                                                                         | Browser-dependent profiles are rejected                                            |
| `network_egress` | Egress from the worker network namespace reaches only the destinations the deployment allows                                  | Profile rejected                                                                   |

If no profile can satisfy a case's requirements (no usable isolation, or the target platform cannot be probed), the runtime reports `ENVIRONMENT_UNAVAILABLE` and routes the case to a human. Escalating such work to an approved external VM is a deployment decision — record the VM's owner and access boundary before enabling `external_vm` isolation.

Worker execution strips GitHub and SSH agent credential variables (`GH_TOKEN`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`, `SSH_AGENT_PID`, and provider-injected tokens) from the worker environment before every shell spawn. Verify after deploy that a worker shell cannot reach the installation token through `env` or credential helpers; the automated check lives in `packages/synergy/test/tool/bash-github-token.test.ts` and should be treated as a preflight gate, not just a CI test.

## Network and Ports

- Run the Synergy server on its own port behind the deployment's reverse proxy; Oryn adds no new listening port.
- Worker network access should be restricted to: the package registry mirror the repositories use, the git remote, and the model gateway. Everything else is denied by the sandbox policy.
- Feishu and GitHub callbacks follow the existing Channel provider requirements; Oryn adds no additional inbound webhook endpoint (GitHub observation is poll-based).

## Channel Test Apps

### Feishu

1. Create a dedicated test tenant app (placeholder name `oryn-test-app`); do not point Oryn at a production bot.
2. Grant the minimal IM scopes needed by the existing Channel provider (receive group/DM messages, send messages, read thread metadata).
3. Configure one account entry under `channel.feishu.accounts` and reference that account ID from `oryn.routes[].feishuAccount`.
4. Set `groupSessionScope` to `group_thread` on the Oryn-bound account so each topic gets its own QA session; other accounts keep their existing scoping.
5. Explicit opt-in: only chats listed in `oryn.routes[].chats` are routed to Oryn. Unlisted accounts and chats keep ordinary Synergy routing. Do not enable Oryn routes on an account that also serves non-Oryn automation without reviewing that interaction.

### GitHub App

Minimal permissions for the Oryn publish transport:

- **Contents: read & write** — push the frozen candidate to the `codex/oryn/<public-token>` branch and read refs.
- **Issues: read & write** — create the case tracking issue and automation comments.
- **Pull requests: read & write** — open the draft PR, update it, and post the review comment.
- **Commit statuses: read** — observe CI on the candidate.
- **Checks: write** — write the `oryn/delivery` check run (see the gating section below).

Do not grant administration, merge, or release permissions. Oryn has no merge or release code path by design; merge remains a human action and the runtime only observes it.

Install the App on the target repositories (placeholder `owner/repo`), set the app credentials in the runtime environment (`SYNERGY_GITHUB_APP_ID`, `SYNERGY_GITHUB_APP_PRIVATE_KEY`), and confirm `resolveInstallation` succeeds before enabling `oryn.repositories`.

## Configuration Checklist

Enable Oryn only after all of the following hold:

- `oryn.enabled: true` with at least one `routes` entry and one `repositories` entry (the schema rejects enabling without them).
- `oryn.repositories[alias].baseBranch` points at the branch PRs target (for this fork's workflow: `dev`).
- `oryn.executionProfiles` declare only capabilities the preflight verified.
- `oryn.limits` reviewed: `maxCaseMinutes` (default 720), `maxConcurrentWorkers` (default 6), `heavyConcurrency` (default 2) — size these to the host.
- `oryn.review.maxRepairRounds` (default 3) and `maxNoProgressRounds` (default 2) reflect the team's appetite for autonomous rework.
- Project-level config does not override runtime-owned Oryn keys; the `runtime` domain owns this key and project config cannot widen the allowlists.

## Quotas and Silent Notifications

- Every stage dispatch, worker report, review, and check run is a durable record; the Feishu reporter receives only the six result kinds (`answer`, `clarification`, `accepted`, `needs_human`, `ready`, `released`) filtered by `oryn.notifications.kinds`. Process noise (tool calls, worker reports, retries) is never delivered.
- `ready` is delivered at most once per case through the durable outbox; retries and crashes cannot duplicate it. Draft PR creation, merge, and release are distinct facts and are never folded into one message.
- Wall-clock and token budgets per case are enforced from the case record; exhaustion hands the case to a human rather than looping.

## Delivery Check Gating

The `oryn/delivery` check run is written only when `oryn.repositories[alias].deliveryCheck` is `true` (default `false`). Follow this sequence when turning it on:

1. Deploy with the check disabled and let at least one real case complete `mark_ready` end to end.
2. Verify the check run appears on the candidate SHA with the expected conclusion on the test repository.
3. Only then set `deliveryCheck: true` and, if branch protection requires it, register `oryn/delivery` as a required check on the target base branch.

Never register `oryn/delivery` as a required check before the deployment has observed it run for real; a required check that the App cannot write blocks every PR on the branch.

## Backup and Recovery

Oryn records live under the single `oryn` storage prefix inside `$SYNERGY_HOME/.synergy/` (placeholder path):

- `oryn/cases/**` — cases, attempts, assignments, runs, reviews, reports.
- `oryn/actions/**` — the external action ledger (authoritative for reconciliation).
- `oryn/claims/**`, `oryn/sources/**`, `oryn/outbox/**` — intake and delivery state.
- `oryn/session_source/**` — host-owned session bindings.

Back up the whole `.synergy/` data directory with the same cadence as the rest of the runtime; there is no separate Oryn backup path. Recovery rules:

- After a crash, intake claims and the action ledger make every step resumable: replayed submissions dedupe to the same case, and ambiguous external actions settle through reconciliation against remote facts (App author, case marker, head SHA) instead of blind replay.
- Never restore a partial `oryn/` subtree alone; restore the storage directory as a unit so ledger, claims, and case records stay consistent.
- Session bindings reference session IDs; restoring data without the sessions directory leaves orphaned bindings, which the host treats as unbound (fail-closed) rather than re-binding automatically.

## Disable and Rollback

Set `oryn.enabled: false` (or remove the `oryn` key) and restart the runtime. Disabled behavior is a product invariant: no Oryn agents, tools, routes, or poll additions execute, and ordinary Channel/Boss/Feishu/GitHub behavior is unchanged. In-flight external actions recorded before the flip are reconciled on the next enabled window; a case left mid-flight stays paused-safe and requires a human to resume.
