# Oryn Deployment Runbook

This runbook covers deploying the Oryn feedback-to-PR runtime on a single Linux host: environment preflight, channel test-app setup, minimal GitHub App scopes, quotas, silent-notification behavior, delivery-check gating, and backup/recovery. All identifiers, paths, and IDs in this document are placeholders — substitute per-deployment values and never commit real secrets, chat IDs, or account IDs.

Oryn is dormant unless `oryn.enabled` is `true`. Deploy the reviewed synergy-oryn revision; an upstream Synergy installation alone does not contain these Oryn changes. Start with one test chat and one test repository. The deterministic pipeline and native Linux tests support pilot acceptance; live App authentication, the target repository's build environment and production-model decisions require the canary below.

## Setup in the Application

Connect the GitHub App and Feishu accounts in Settings → Channels first. Add the App-authorized repositories to the GitHub account and refresh Feishu projects after adding the bot to a group. A topic appears after Oryn has received a conversation there. Repository access and discovered destinations are installation-owned; no credentials are returned by the Oryn setup API.

Open Settings → Oryn. Choose the default repository, its absolute server-side trusted checkout and target branch. The checkout's `origin` must match the selected repository and `origin/<branch>` must already resolve. Choose an optional Feishu group or topic for human intervention. Saving installs an explicit route for that group and selects threaded group sessions on the Feishu account. Other explicit repository configurations remain available in the advanced installation policy.

Enable backfill to include existing open Issues and PRs, independent review to review contributor PRs, and automatic coding only when the repository's execution profiles and native containment are ready. These switches map to `oryn.repositories[alias].github.{enabled,backfill,autoReview,autoFix}`. The default alias and destination are `oryn.defaultRepoAlias` and `oryn.notifications.target`. Execution profiles, dependency snapshots and resource ceilings still require the preparation described below; the setup page does not authorize arbitrary commands.

GitHub needs only outgoing HTTPS. Incremental changes continue while the open backlog is scanned. An exact standalone `@oryn review`, `@oryn fix` or `@oryn stop` comment requires repository write, maintain or admin permission; quoted commands and bot comments are not authority. External PR fixes are adopted into a separate PR, preserving the original commits. Humans merge every PR.

A review identifies its base/head and publishes actionable line comments where the reported line exists in the changed diff. It includes each domain's recommendation, evidence assessment, questions and limitations. A review does not write a successful delivery check. Missing reproduction or environment evidence transfers work to a human. GitHub-origin handoffs and gated ready results use the selected Feishu destination; ordinary progress remains silent.

Discoveries keep their source Case and version. Independent or blocking bugs create a private reproduction Case before any public Issue. Security findings stay private, environment gaps require environment repair, and current-change defects stay in the existing review. Exact local observations deduplicate; `maxDiscoveryDepth` and `maxDescendants` default to 2 and 8. Descendants share the root wall-clock deadline. Semantic deduplication across unrelated wording and aggregate token accounting still require operator judgment and monitoring.

Back up the full runtime state, including `oryn/github`, `oryn/github_cursors`, `oryn/github_owned` and `oryn/discoveries`. A lost Review response leaves an ambiguous receipt; polling searches the App's review marker before settling it and never automatically resends an uncertain publication. Retain old receipts when updating PRs. Poll snapshots retain the latest 100 combined comments/reviews; use GitHub for complete discussion history.

Run `bun run test test/oryn/github-inbox.test.ts test/oryn/github-runtime.test.ts test/oryn/github-review.test.ts test/oryn/discovery.test.ts test/oryn/setup.test.ts test/channel/provider/github/oryn-intake.test.ts` from `packages/synergy`. The setup browser test is `packages/app/test/components/settings/panels/OrynPanel.test.ts`. These tests use isolated state and synthetic remote responses; validate App permissions and the selected Feishu destination on the pilot before broad intake.

## Pilot Acceptance Order

1. On the dedicated Linux account, prepare the reviewed fork checkout using Bun 1.3.14 and `bun dev prepare` from the repository root. Rust, Bubblewrap, usable namespaces and the process-resource setup below are required for candidate execution. A successful preparation command alone does not prove sandbox readiness.
2. Use a dedicated `SYNERGY_HOME` consistently for preparation and runtime startup. For example, `SYNERGY_HOME=/srv/oryn/runtime` places configuration under `/srv/oryn/runtime/.synergy/config/synergy.d/`; it is a home prefix, not the final hidden directory. Keep the runtime checkout separate from the target repository checkout and all worker directories.
3. Configure the model/provider domains, embedding in `00-general.jsonc`, both Channel accounts in `90-channels.jsonc`, and the Oryn routes, trusted repository checkout, execution profiles and budgets in `120-runtime.jsonc`. Use the sections below for the actual values and dependency preparation. Keep Oryn disabled until these inputs are ready.
4. Run the deterministic pipeline acceptance command below on the reviewed checkout. On Linux, also run the native sandbox/resource suites described below. These use isolated test homes and local fixtures; they do not validate the credentials configured for the pilot.
5. Enable the single-chat Oryn route. For source-based acceptance, start from the fork root with `SYNERGY_HOME=/srv/oryn/runtime bun dev server --hostname 127.0.0.1 --port 4098`. Keep this foreground process under the dedicated account; a service supervisor must preserve the same home, checkout, Bun path and credential environment. Do not run two servers against the same home. This is the source acceptance command, not an upstream package installation.
6. In the test chat, ask one ordinary usage question, submit one known reproducible defect and submit one report lacking reproduction details. Require a direct answer for the question, an Issue and independently checked PR for the defect, and a specific request for human input for the incomplete report. Check that all replies remain on their originating topic and no worker/tool progress is posted.
7. On the test repository, exercise a rejected candidate followed by repair on the same PR. Confirm the PR head, test evidence and independent review refer to the same candidate SHA; inspect the Mermaid summary and optional status labels. Humans retain merge responsibility. Configure the optional delivery check in the order specified below.
8. Before expanding intake, restart only the dedicated pilot runtime with work in progress and verify the original Case, Issue and PR are reused. Confirm GitHub polling resumes. Inspect ambiguous Feishu sends manually: the outbox deliberately avoids automatic resends, so a lost send acknowledgment can require manual notification recovery.

From `packages/synergy`, the repeatable data-flow acceptance command is:

```bash
bun run test test/oryn/feishu-ingress.test.ts test/oryn/model-pipeline.test.ts test/oryn/engineering-pipeline.test.ts test/oryn/success-pipeline.test.ts test/oryn/process-restart.test.ts test/oryn/pr-restart.test.ts test/oryn/outbox.test.ts
```

These experiments cover topic ownership, duplicate intake, real Boss/worker handoff, baseline failure and candidate success, independent review, repair, remote-write uncertainty, runtime death and quiet replies. Feishu/GitHub transports and model choices are simulated; a green result is evidence of the implemented data flow, not live end-to-end acceptance.

Oryn authorization must be configured in the installation-owned `120-runtime.jsonc` domain. Project-local configuration and scoped overrides do not authorize Oryn repositories, execution profiles, publication or budgets. Do not copy a candidate repository's configuration into the installation. Configure model roles through installation model settings; Oryn agent IDs, prompts and role definitions are reserved. See [installation policy](../decisions/implemented/architecture/2026-09-08-oryn-installation-policy.md) for the enforced scope and remaining execution checks.

Worker source separation is covered by [versioned-workspace tests](../decisions/implemented/architecture/2026-09-08-oryn-versioned-worker-workspaces.md). Every new worker needs enough disk for a worktree; repro/code pin baseline and verify/review pin candidate. Historical main-checkout workers must be stopped and replaced, not rebound while active. Git filters, submodules and dirty overlays require a contained execution path that is not delivered by these checks. Before pilot intake, configure the aggregate user-slice limits below and validate the target repository’s dependencies; the deterministic pipeline does not establish its build compatibility.

The shared check runner bounds output and manages ordinary Unix descendants, as described in [check process lifecycle](../decisions/implemented/bug-fix/2026-09-08-owned-check-process-lifecycle.md). Checks use an explicit sandbox policy with read-only source, private disposable HOME/temp paths and restricted networking; see [check containment](../decisions/implemented/bug-fix/2026-09-08-oryn-check-containment.md). Check-heavy and profile limits now use [ToolScheduler resource admission](../decisions/implemented/architecture/2026-09-08-oryn-check-resource-admission.md); these counters do not include coder Bash/background processes. Model turns separately use the foreground reservation described below. Worker Bash uses its own strict Host policy, described below; these process policies do not establish complete deployment acceptance.

## Engineering Checkout and Startup

Automatic Feishu Case startup requires `oryn.repositories[alias].directory` to name an absolute, trusted, pre-fetched local checkout. Its canonical directory must be the Git root, its `origin` must match the configured GitHub owner/repository, and `refs/remotes/origin/<baseBranch>` must resolve to a commit. Prepare or fetch that checkout through the authorized deployment workflow before enabling intake. `workRoot` is a container for worker directories and does not replace this checkout.

Case submission returns separate acceptance and engineering startup results. Missing or mismatched setup leaves a durable blocked reason visible through `oryn_case` get; it does not use the QA directory. Correct the setup and resubmit the same request or restart the dedicated test runtime to retry. Startup preserves its reserved Session/Attempt and baseline across retries; it does not switch or reset the checkout. The engineering root reads that configured checkout, so keep it under operator control; this path does not yet provide frozen candidate execution.

Run `bun test test/oryn/engineering-start.test.ts test/session/creation-recovery.test.ts` from `packages/synergy` to verify creation interruption, replay, origin validation and cancellation against temporary repositories. It holds Session leases to avoid invoking a live model. Use the pilot acceptance sequence above for the complete deterministic pipeline and the subsequent live canary.

Code workers prepare a commit with `oryn_result` / `input.kind: commit_candidate`, supplying the assignment identity, stable request key, conventional title and explicit relative file paths. The Host returns the full candidate SHA and local branch for the subsequent candidate report. Use the same request after interruption; changed requests or changed source require inspection. The Host does not execute repository commit hooks, and repositories with Git filters or submodules need separate support. Independent checks and review remain required. Do not grant the worker shell write access to the common Git directory to make `git commit` succeed.

## Trusted Local Execution

For an installation that deliberately grants candidate code the runtime OS user's filesystem and network access, set `oryn.executionMode` to `"trusted_local"` in the runtime config domain. This selects unwrapped execution for checks and engineering Bash. It requires no proc mount, Docker, systemd or cgroup when process-resource limits are omitted. Outer-platform permissions still apply.

```jsonc
{
  "oryn": {
    "executionMode": "trusted_local",
  },
}
```

Merge this field into the existing Oryn configuration. Remove `namespace` and `seccomp` from the selected check profiles' `requiredCapabilities`; omit `limits.processResources` and profile `resourceLimits` if no cgroup manager is available. Required capabilities are still checked, and mode selection does not erase them. `network_egress` is available in trusted-local profiles; `uid` and `browser` remain unsupported.

Finish or stop existing engineering tasks before changing modes. New engineering roots use `full_access` in trusted-local mode; existing roots retain their selected control profile. Worker roles, assignment ownership, candidate freezing and PR review/delivery rules continue to apply. Command timeouts, output limits, scheduler concurrency and process cleanup remain enabled.

Checks still materialize a disposable version-pinned checkout and record the mode in their receipts. Their clean environment does not prevent reading other files accessible to the runtime OS user. Filesystem and network containment are absent in this mode, including for worker Bash. Revert the setting to `"sandbox"` for newly created engineering tasks and sandboxed checks; there is no automatic fallback from sandbox to trusted-local execution.

## Isolation Preflight

`oryn_check` defaults to local `sandbox` isolation. Explicit `worktree` and `external_vm` execution are rejected: directory separation is insufficient and no VM execution transport is connected. macOS uses a deny-default Seatbelt profile; Linux requires the built helper and Bubblewrap with usable user/PID/network namespaces and seccomp. A missing or rejected wrapper cannot fall back to an unwrapped command, regardless of ordinary interactive sandbox fallback settings.

The sandbox check profile exposes a disposable checkout of the pinned commit, plus system executables/libraries and the approved executable. Tracked source remains read-only. Installation-selected output directories are writable and shared by the commands in that check plan. Each command gets a private disposable HOME/temp directory, with ambient credentials and Git configuration excluded. Host network access is denied. Dependency provisioning, persistent cross-run build caches, source overlays and browser execution need separate support; do not interpret those environment gaps as a reproduced bug.

| Declared capability                | Local check behavior                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `namespace`, `seccomp`             | Accepted only on Linux; actual helper startup must succeed. These checks do not establish cgroup or separate host-UID isolation.    |
| `cgroup`                           | Requires configured process limits and Linux cgroup v2; the trusted runner validates the applied controls before sandbox execution. |
| `uid`, `browser`, `network_egress` | Rejected as unavailable. The runtime does not provide these capabilities for checks.                                                |

Run `bun test test/oryn/sandbox.test.ts test/oryn/workspaces.test.ts test/sandbox/explicit-profile.test.ts` from `packages/synergy`. Native Linux execution needs the locally built helper installed in the sandbox helper search path and Bubblewrap. The dedicated Oryn Native Containment workflow provisions these on an ephemeral Linux VM without Docker. Native macOS checks, Linux native checks and compiler/serialization assertions are distinct evidence; inspect the workflow result for the exact commit before treating Linux execution as validated.

Oryn worker Bash uses [assignment-bound shell containment](../decisions/implemented/bug-fix/2026-09-08-oryn-worker-shell-containment.md): a private disposable HOME/temp directory, restricted networking, system runtime files, and the assigned source worktree. Reproduction and coding can edit their source before freeze; frozen candidates are read-only. Git status/diff use a disposable metadata view and the repository's read-only objects, without host Git configuration or credentials. Use `oryn_result` candidate preparation for durable commits; shell Git staging or branch changes remain disposable. Long commands use tracked background processes attributed to the worker Session; a worker can inspect or control only its own running and finished entries. Frozen or handed-off assignments cannot receive more process input, while own-process cleanup remains available. Kill/remove await process-group termination and scratch cleanup. Case pause, takeover, cancel and handoff stop bound engineering/worker execution through [Case execution control](../decisions/implemented/bug-fix/2026-09-08-oryn-case-execution-control.md). External control waits for registered work and process cleanup; concurrent transitions return a conflict and must be retried after cleanup. QA stays available. Resume re-arbitrates queued tasks and requests [bounded interrupted-task recovery](../decisions/implemented/bug-fix/2026-09-08-oryn-interrupted-task-recovery.md) in the existing Session. Three consumed recovery instructions per task exhaust automatic recovery and hand the Case to a human. A new Attempt after epoch invalidation is not allocated automatically. Startup retries inactive-Case cleanup using the current process registry; it does not discover OS orphan processes from an earlier runtime. Dependency downloads and platform/browser workloads require further environment support. Optional process quotas use the Linux resource scopes described below. If the required execution capability is unavailable, preserve the Case for human intervention rather than changing to `full_access`.

Run `bun run test test/oryn/shell.test.ts` from `packages/synergy` for actual central-resolver execution, credentials and host-file exclusion, Git inspection, read-only freeze, local network denial, remote/cwd rejection and background cleanup. The native workflow includes this suite on both Linux versions. These tests exercise local processes and scripted inputs; they do not establish isolation of arbitrary host plugins, other file tools or credentials already committed to the candidate repository.

### Ubuntu namespace policy

On Ubuntu hosts that restrict unprivileged user namespaces, install the distribution's current Bubblewrap and AppArmor packages and have the administrator verify that an approved `bwrap-userns-restrict` profile is loaded. Ubuntu 24.04 packages may omit this optional profile; the CI setup retrieves the [AppArmor 4.0.3 profile at a fixed commit](https://gitlab.com/apparmor/apparmor/-/blob/b4dfdf50f50ed1d64161424d036a2453645f0cfe/profiles/apparmor/profiles/extras/bwrap-userns-restrict) and verifies its SHA-256 before installation. That profile permits Bubblewrap setup while restricting child capabilities; use the reviewed profile rather than disabling AppArmor or its system-wide namespace restriction. See [Ubuntu's explanation and profile guidance](https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007). If host policy forbids namespaces, retain the environment failure and route the task to an authorized environment or a human.

Before starting candidate work, verify the actual helper through the native Oryn tests. A minimal Linux preflight must include a new proc mount: `bwrap --unshare-user --unshare-pid --unshare-net --ro-bind / / --proc /proc /usr/bin/true`. A namespace-only probe can pass while the actual sandbox fails with `Can't mount proc on /newroot/proc: Operation not permitted`. This requires host support for nested proc mounts; installing systemd, enabling cgroups or sealing dependencies does not resolve it. Keep execution unavailable until the host policy permits the operation. `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted` is a sandbox startup failure, not a reproduced application bug. The CI-only `script/prepare-linux-test-sandbox.sh` provisions disposable GitHub-hosted VMs, loads the approved profile when namespace restrictions are enabled, and probes network namespace startup. It refuses ordinary deployment hosts; production setup remains an administrator operation.

## Network and Ports

- Bind the Synergy server on its own port; Oryn adds no new listening port. Use loopback for a local tunnel, or an explicitly chosen interface such as `0.0.0.0` when the deployment platform forwards ports from the internal network. A public reverse proxy is unnecessary.
- Check subprocesses have no host network access. Feishu, GitHub and model connections belong to the runtime; installing dependencies and network-dependent tests need separate, authorized execution support.
- Feishu uses the provider's outbound WebSocket connection and GitHub uses outbound HTTPS polling. Configure Feishu event reception in long-connection mode. No public inbound IP or webhook endpoint is needed for this path; the host must reach Feishu, GitHub and the selected model/embedding services.

## Channel Test Apps

The local mock ingress check needs no Feishu credentials. From `packages/synergy`, run `bun test test/oryn/feishu-ingress.test.ts test/oryn/outbox.test.ts test/oryn/tools.test.ts`. It enters the real ChannelHost, persists Inbox tasks, executes the reply tool and sends through a captured provider. It verifies thread/reply routing and uncertain dispatch with synthetic assistant output. It does not prove live Feishu delivery, model behavior, candidate execution, or GitHub publication; those require separate evidence.

To exercise model-driven QA without model or Feishu credentials, run `bun run test test/oryn/model-pipeline.test.ts` from `packages/synergy`. The reusable `test/oryn/fixtures/model.ts` serves deterministic OpenAI-compatible chat SSE and embedding responses on a loopback ephemeral port; the configured provider, LLM loop, real tool resolver, Case intake, human handoff and explicit reply outbox all execute normally under the isolated test home. Memory recall uses the configured loopback embedding endpoint; it does not download a local embedding model. Synthetic vectors verify transport and workflow wiring, not semantic retrieval quality. The fixture deliberately omits the approved repository directory and verifies one `needs_human` response, no PR, no internal progress messages and no repeated QA inference for the duplicate provider event. It waits for the owning QA task to settle before checking replay. It does not run coding, review, GitHub publication or a model worker subprocess, and scripted choices do not establish a live model's judgment.

### Feishu

1. Create a dedicated test tenant app (placeholder name `oryn-test-app`); do not point Oryn at a production bot.
2. Grant the minimal IM scopes needed by the existing Channel provider (receive group/DM messages, send messages, read thread metadata).
3. Configure one account entry under `channel.feishu.accounts` and reference that account ID from `oryn.routes[].feishuAccount`.
4. Set `groupSessionScope` to `group_thread` on the Oryn-bound account so each topic gets its own QA session; other accounts keep their existing scoping.
5. For the setup picker, grant the app permission to list its joined groups, add the bot to the target group, then use **Channels → Feishu → Refresh groups** (also available as account refresh in the sidebar). Return to **Oryn** to choose the default notification target. Feishu group listing excludes direct chats; an existing configured direct-chat target remains selectable, and other direct chats appear after Oryn receives a conversation. Refresh reads group metadata only; failed or incomplete pagination preserves existing groups.
6. Set a non-empty `oryn.routes[].chats` allowlist to restrict intake to the intended test chats. An omitted or empty `chats` list matches the whole configured account; it does not disable intake. Accounts without a matching Oryn route keep ordinary Synergy routing.

Run `bun run test test/oryn/model-pipeline.test.ts test/oryn/engineering-pipeline.test.ts` to include the real engineering root, Boss worker, independent worktree, baseline check receipt and report-driven human handoff. The attachment assertion passes on the supplied baseline; the expected outcome is a request for the failing input and client version, not a claimed bug fix. Both scenarios use only loopback model and captured Feishu transport.

Run `bun run test test/oryn/success-pipeline.test.ts` for the complete deterministic success branch. A failing attachment assertion leads to a real code edit and Host commit, a separate verification worker executes the same assertion against the fixed candidate, and a separate reviewer reads both receipts before publication. The GitHub fixture captures tracking issue, draft PR, review and ready operations; the reporter receives acceptance and the final PR link without internal progress messages. The same suite also runs a rejected first candidate through review, Attempt rotation and a corrected candidate on the same PR. Code and review workers read the persisted prior finding; assertions retain the failed verification and old review, persist the addressed finding and emit only the final corrected PR notification. This verifies runtime wiring and local execution with simulated GitHub facts; it does not establish live GitHub publication or production-model judgment.

Run `bun run test test/oryn/pr-restart.test.ts test/oryn/process-restart.test.ts` for real runtime process death and restart against an isolated durable home. The PR scenarios hold responses after simulated Draft creation, candidate refresh or readiness, kill the owned runtime process group, and require recovery to the same PR without another remote write or crossed/repeated reporter delivery. They retain actual failing baseline and passing candidate checks, independent review, and the open/resolved finding history for repair. A further restart after completion preserves the existing Attempts, Assignments and publication receipts. The shared model scenario reconstructs progress from tool history. Optional LSP diagnostics and formatter startup are disabled in these deterministic PR experiments; native check execution remains enabled. Linux requires the source-built sandbox helper and functioning user namespaces/bubblewrap, as provisioned by the native CI workflow. Live GitHub authentication and production-model judgment still need separate acceptance.

The same-process PR experiments allow four minutes for completion; process-restart experiments allow three minutes per phase. They stop with recent worker and durable-state diagnostics if those bounds expire. These deadlines accommodate loaded Linux CI workers and do not change product budgets or relax delivery assertions.

A human handoff records its reason in the Case and shows the public-safe projection in the Oryn task detail. The Host queues one result per linked reporter, so the QA model does not need to send a second notice. Startup repairs a missing intent after interrupted persistence; it never automatically replays an ambiguous send. Resuming the Case suppresses a queued old handoff, and disabled notification kinds are settled as suppressed rather than sent later. Inspect the engineering task when the public reason is redacted.

Ready notifications contain the PR link and candidate SHA from an acknowledged publication. Before sending, Oryn rechecks the remote PR, current CI and local delivery gate; GitHub observation failure leaves the intent pending. Restart recovery repairs missing intents and preserves confirmed or ambiguous legacy outcomes. Run `bun run test test/oryn/publish.test.ts test/oryn/action-migration.test.ts test/oryn/outbox.test.ts` for publication and notification regressions; these use simulated GitHub and Feishu transports.

## GitHub App

Minimal permissions for the Oryn publish transport:

- **Contents: read & write** — push the frozen candidate to the `codex/oryn/<public-token>` branch and read refs.
- **Issues: read & write** — create the case tracking issue and automation comments.
- **Pull requests: read & write** — open the draft PR, update it, and post the review comment.
- **Commit statuses: read** — observe CI on the candidate.
- **Checks: write** — write the `oryn/delivery` check run (see the gating section below).

Do not grant Administration or protection-bypass privileges. GitHub does not provide an independent deny-merge permission alongside these write permissions; human review requirements and the Host operation allowlist must enforce the merge policy. Oryn exposes no merge or release operation.

Install the App on the target repositories (placeholder `owner/repo`), set the app credentials in the runtime environment (`SYNERGY_GITHUB_APP_ID`, `SYNERGY_GITHUB_APP_PRIVATE_KEY`), and confirm `resolveInstallation` succeeds before enabling `oryn.repositories`.

Also configure an enabled GitHub Channel account with a non-empty repository list in `90-channels.jsonc`. App credentials and Oryn repository mappings alone do not start the background poll loop. Oryn's unresolved-publication reconciliation and label synchronization are attached to that loop after a successful repository poll. Retain polling while disabling the ordinary GitHub Channel's automatic conversation/review agents:

```jsonc
{
  "channel": {
    "github": {
      "type": "github",
      "accounts": {
        "oryn-poll": {
          "enabled": true,
          "repositories": ["owner/repo"],
          "workspaceDir": "/srv/oryn/github-channel",
          "pollingIntervalMs": 300000,
          "autoReview": false,
          "autoRespond": false,
        },
      },
    },
  },
}
```

Merge this with the Feishu account in the same Channel domain. The two flags suppress ordinary GitHub event-triggered sessions; they do not disable Oryn's assignment-based reviewers or its polling reconciliation. This pilot routes new work through Feishu; automatic intake of arbitrary GitHub comments is not enabled by this configuration. A failed GitHub poll delays reconciliation, so inspect account health when an uncertain publication or status label remains unchanged beyond its polling interval.

Oryn pushes through the Host-installed Git executable to the configured repository's explicit `https://github.com/owner/repo.git` URL. The publishing process does not inherit personal Git config, proxy variables, SSH settings, custom CA overrides or candidate hooks. Provision direct outbound HTTPS and a working system trust store for Git; changing `origin` or a worker environment does not configure publication. GitHub Enterprise and proxy-only publication require a separate reviewed transport configuration and are not supported by this path. Candidate objects must remain available until publication settles. Temporary bare repositories contain no persisted installation token; normal completion/cancellation removes them. After a Host crash, remove leftover `oryn-push-*` cache directories only while that runtime is stopped.

## Disposable Build Experiments

Set `oryn.executionProfiles[profileId].writableDirectories` in the installation runtime domain to the relative output directories that a check needs. For example:

```jsonc
{
  "oryn": {
    "executionProfiles": {
      "build": {
        "commandAllowlist": ["bun", "git"],
        "writableDirectories": ["dist", "coverage", "packages/synergy/dist"],
        "timeoutSeconds": 600,
        "maxConcurrent": 1,
      },
    },
  },
}
```

Merge these fields into the existing installation configuration. An absent or empty directory list keeps all experiment source read-only. A repository's `testProfiles` restricts which installation profiles it may execute; unset permits the configured profiles, while an empty list permits none. Engineering and worker Agents discover these profiles through `oryn_case get`; QA does not receive the engineering configuration.

Each check plan gets a fresh private Git checkout built from the assigned commit's objects, with its own index/configuration and detached HEAD. It does not copy ignored/untracked files, local dependency installations, candidate hooks or host Git configuration. Commands in the same plan share approved output directories; separate plans, Cases and baseline/candidate runs do not. Only output paths free of tracked source and symlink ancestors are allowed. Parent traversal and Git/agent metadata paths are rejected. Source edits and symlink escapes remain denied by the OS sandbox; changed source or ownership makes evidence inconclusive. Plans requesting source overlays are rejected because no patch-application mechanism supplies that evidence.

The checkout and outputs are removed after the plan settles and owned processes stop. Dependency inputs can be supplied by sealed snapshots as described below; output artifact retention and automatic cache collection are not implemented. The runner does not borrow the configured checkout's `node_modules` or run network-enabled installation scripts. Following a Host crash, inspect leftover `oryn-experiment-*` temporary directories only while the runtime is stopped and its owned processes are confirmed terminated; automatic orphan discovery is not implemented.

Run `bun run test test/oryn/experiment.test.ts test/oryn/workspaces.test.ts test/oryn/sandbox.test.ts test/oryn/tools.test.ts` from `packages/synergy`. The native tests build and execute real TypeScript through `Bun.build()`, inspect the exact Git HEAD, reject source/metadata writes, prove separate experiments and check cleanup. Linux CI additionally exercises the `bun build` CLI. On macOS, Bun CLI and bare-package resolution can require forbidden ancestor-directory reads even with a valid project manifest; only dependency-free `Bun.build()` is verified there. Host-directory reads are not widened to hide that limitation. A target-specific build failure remains an environment gap unless independent evidence establishes a product defect.

## Sealed Dependency Inputs

Prepare dependencies on the same Linux architecture and exact Bun version as the runtime, in a separate reviewed clean checkout. The runtime performs no package installation. For a repository whose dependencies work without lifecycle scripts, use `bun install --frozen-lockfile --ignore-scripts` in that checkout, then confirm the intended checks have the required dependencies. This operator step may require outbound access; do not run it with GitHub App keys, Feishu credentials or the production runtime home in its environment. Native dependencies requiring install scripts need a separately reviewed preparation step; a snapshot does not prove which commands created its bytes.

Use the installed product command to seal the existing dependency directories. The destination parent must exist, the destination itself must be new, and it must be outside the source checkout. Paths below are placeholders:

```bash
synergy oryn seal-dependencies /srv/oryn/provisioned-source /srv/oryn/dependencies/baseline --json
```

Success prints JSON with `directory`, `digest`, `files` (file/link entries) and `bytes`; failure exits nonzero. The command performs no installation or network access and does not replace existing output. Merge the returned directory and manifest SHA-256 into the relevant installation profile:

```jsonc
{
  "oryn": {
    "executionProfiles": {
      "build": {
        "commandAllowlist": ["bun", "git"],
        "writableDirectories": ["dist"],
        "dependencySnapshots": [
          {
            "directory": "/srv/oryn/dependencies/baseline",
            "digest": "<64-character-lowercase-sha256-from-command>",
          },
        ],
      },
    },
  },
}
```

Keep snapshots installation-owned and stable while checks use them. A snapshot contains a version-1 manifest and content-addressed blobs, without copying the source checkout or runtime credential stores; repository-contained absolute links are normalized to relative targets. The operator must ensure the preinstalled dependency tree itself contains no private material. It pins the Host platform, architecture, exact Bun version, tracked package manifests, Bun locks/configuration, package-manager configuration and declared Bun patch files. Registry/Git dependencies and repository-local workspace links are supported. Bun workspace arrays and object declarations with a `packages` array are supported; catalogs are pinned through the root manifest. Copied `file:`/`link:` dependencies and malformed workspace declarations are rejected; they need an expanded input policy. Other runtime/OS library versions and installation-script provenance are not attested by this format.

At most 16 snapshots may be configured per profile. Exactly one must match the assigned commit's dependency inputs and Host runtime. A normal source-only change can reuse a snapshot; dependency-input changes require a new snapshot. Baseline and candidate snapshots can coexist when their dependency inputs differ. Do not configure duplicate matches. Without configured snapshots, dependency-free checks remain available; missing dependencies must be reported as an environment gap. A configured missing, damaged, unsupported or ambiguous snapshot fails with `ENVIRONMENT_UNAVAILABLE` before commands run, allowing the Case to transfer to a human instead of claiming a product bug.

Each experiment receives its own copies after manifest/blob digest verification; dependencies remain read-only in the native sandbox. Workspace links bind to that experiment's source and final targets must stay within it, outside protected metadata. Snapshot paths are hidden from engineering model profile discovery; digests are visible and successful run observations identify the selected digest. The snapshot proves the copied inputs, not installation completeness or correctness. Do not treat sealing as a successful project build.

Version 1 limits individual files to 512 MiB, total referenced file bytes to 64 GiB, manifests to 64 MiB, entries to 250,000 and dependency roots to 256. Capacity planning must include one materialized dependency tree per concurrent experiment plus retained snapshots. Ordinary completion/failure/cancellation cleans owned temporary outputs; a hard crash during sealing can leave a destination requiring operator inspection. Unsupported manifest versions are rejected; there is no Case-store migration. Back up the manifest and blobs together with the matching installation configuration. Remove a retained snapshot only after removing its profile reference and draining its users; automatic garbage collection is not implemented.

Run `bun run test test/oryn/dependencies.test.ts` from `packages/synergy`. The suite exercises the installed CLI entry point, snapshot reuse/invalidation, tampering, relative and chained link escape rejection, dependency write denial and cleanup. Linux native CI also compiles and executes an application using a sealed package and a workspace dependency. macOS records the package-resolver containment limitation described above; it is not the deployment acceptance platform.

## Linux Process Resource Limits

Set `oryn.limits.processResources` in the installation runtime domain to bound every check and worker Bash command. This requires cgroup v2, `/usr/bin/systemd-run`, `/usr/bin/systemctl`, the dedicated account's user manager and delegated CPU/memory/PID controllers. It requires no Docker and does not replace namespace/seccomp containment. Missing controllers, an unavailable user manager or unsupported platform rejects configured execution instead of running without the limits.

During host provisioning, an administrator starts the dedicated account's user manager and enables lingering so it survives logout. Use the dedicated account's numeric UID in a `user@<uid>.service` override with `[Service]` and `Delegate=cpu memory pids`, reload systemd, and start that manager before starting Oryn. Apply this to the dedicated account, not every user's manager. A manager restart stops that account's units, so complete provisioning before production work. CPU delegation needs explicit verification on older distributions. For an ephemeral CI host, the equivalent setup is:

```bash
oryn_unit="user@$(id -u).service"
sudo systemctl stop "$oryn_unit"
sudo install -d "/run/systemd/system/${oryn_unit}.d"
printf '[Service]\nDelegate=cpu memory pids\n' | sudo tee "/run/systemd/system/${oryn_unit}.d/oryn.conf" > /dev/null
sudo systemctl daemon-reload
sudo loginctl enable-linger "$(id -un)"
sudo systemctl start "$oryn_unit"
```

A starting policy for the 20-core/80-GB pilot is shown below. The numbers are proposed limits, not measured capacity. Keep heavy check admission at two, account for simultaneous worker Bash commands, and configure a dedicated-user aggregate memory/CPU/task ceiling with systemd so the sum of independent scopes cannot consume the entire VPS. Scope creation uses the user manager, so a limit applied only to the Oryn server service does not cover its sibling scopes; place aggregate limits on the dedicated user's parent slice. For example, reserve host capacity by starting below 64 GiB and 16 CPUs for that user's total workload, then tune from observed peaks.

```jsonc
{
  "oryn": {
    "limits": {
      "processResources": {
        "memoryMiB": 12288,
        "cpuQuotaPercent": 400,
        "maxProcesses": 256,
        "maxSeconds": 1800,
      },
    },
    "executionProfiles": {
      "build": {
        "commandAllowlist": ["bun", "git"],
        "requiredCapabilities": ["namespace", "seccomp", "cgroup"],
        "writableDirectories": ["dist"],
      },
    },
  },
}
```

`memoryMiB` caps memory charged to the whole command scope and disables swap. `cpuQuotaPercent: 400` caps its aggregate CPU time to four CPUs; it is not a CPU affinity setting. `maxProcesses` counts threads as well as processes and descendants. `maxSeconds` is a systemd scope lifetime, defaults to 1800 seconds and continues without the Host; it is independent of the check/Case timeouts. Check-profile `resourceLimits` can lower these values but cannot exceed installation ceilings. The limits are optional for compatibility; enabling `oryn` alone does not configure OS quotas. Worker Bash needs the installation ceiling even when a check profile specifies its own limits.

Before starting the sandbox wrapper, the trusted runner verifies its assigned scope and actual kernel memory, swap, CPU and task controls. It executes from a private Host directory/home, excludes candidate Bun configuration and passes only the original restricted environment to the sandbox. Missing completion evidence or observed memory/task exhaustion is an environment gap, not a reproduced product bug. Ordinary completion/cancellation stops the owned scope before releasing its temporary files. A hard Host crash can leave scopes until their lifetime cap expires; inspect `systemctl --user list-units 'oryn-command-*.scope'` under the dedicated account and stop remaining scopes only after confirming the runtime is stopped. The runtime does not automatically discover old scopes.

Run `SYNERGY_TEST_ORYN_CGROUP=1 bun run test test/oryn/resource-limits.test.ts test/oryn/shell.test.ts` from `packages/synergy` on the provisioned Linux host. This opt-in suite must pass before enabling unattended builds; ordinary macOS runs test rejection and configuration behavior and skip native cgroup cases. The native workflow provisions the manager on Ubuntu 22.04 and 24.04. Dependency materialization, Host memory, model inference, total Case/worker limits and persistent artifact retention require their own capacity accounting; per-command scopes do not claim to reserve QA memory.

## Model Capacity

The existing Agent worker pool reserves one slot from Oryn engineering/model workloads when `execution.agentWorkers >= 2`. For a ceiling of 4, at most 3 Oryn engineering turns occupy workers simultaneously; QA can use the remaining capacity. Host Session bindings and rollout attribution determine the class, including engineering-owned derived calls. Foreground includes QA and other ordinary Synergy inference, so unrelated foreground traffic can still contend with QA. At a ceiling of 1, engineering remains runnable but no independent QA slot exists. Pool resize drains existing turns without preemption.

Background admission also preserves one queue position and `min(64 MiB, half the configured queue-byte budget)` for foreground submissions. Requests still obey the shared aggregate limits; on small byte budgets a foreground request can exceed the reserve and be rejected. The pool starts the oldest eligible entry, allowing QA past blocked engineering work and retaining engineering queue order. Queued cancellation removes its byte charge; provider completion retains the slot until the worker releases its stream. These controls bound provider turns, not open Cases, durable Boss workers, test processes, provider quotas or OS resources.

Run `bun run test test/session/agent-worker-pool.test.ts test/session/agent-turn.test.ts test/oryn/worker-start.test.ts` from `packages/synergy` for Host classification, saturated count/byte admission, release, cancellation and resize behavior. The pool admission scenarios use controlled worker protocol fixtures. `test/oryn/process-restart.test.ts` separately starts three real model worker processes, holds two engineering requests at the simulated provider and verifies a third Feishu question receives its answer before those requests are released, without creating another Case or Issue. It then exercises runtime death and retained Case recovery. Measure provider rate limits, foreground latency and model memory on the target VPS before raising concurrency.

## Configuration Checklist

Enable Oryn only after all of the following hold:

- `oryn.enabled: true` with at least one `routes` entry and one `repositories` entry (the schema rejects enabling without them).
- `oryn.repositories[alias].baseBranch` points at the branch PRs target (for this fork's workflow: `dev`).
- `oryn.executionProfiles` declare only capabilities the preflight verified.
- Set `oryn.limits.heavyConcurrency` for check processes (runtime default 2) and `maxCaseMinutes` for the Case wall-clock budget (default 720). Total Session-worker counts, `lightConcurrency` and model-token limits remain unenforced; the corresponding schema descriptions are not proof of enforced limits. Set `execution.agentWorkers` to at least 2 for foreground capacity reservation; 4 is a starting point to measure on the target VPS.
- `oryn.review.maxRepairRounds` (default 3) and `maxNoProgressRounds` (default 2) reflect the team's appetite for autonomous rework.
- Project-level config does not override runtime-owned Oryn keys; the `runtime` domain owns this key and project config cannot widen the allowlists.

## Quotas and Silent Notifications

- Every stage dispatch, worker report, review, and check run is a durable record; the Feishu reporter receives only the six result kinds (`answer`, `clarification`, `accepted`, `needs_human`, `ready`, `released`) filtered by `oryn.notifications.kinds`. Process noise (tool calls, worker reports, retries) is never delivered.
- Reply intents deduplicate by recipient and operation. Answers and clarifications are scoped to the host-owned root turn, so later questions can receive answers. Before transport invocation, the outbox records an uncertain dispatch; a confirmed response settles it to delivered. Timeout or interruption does not trigger an automatic resend. Draft PR creation, merge, and release are distinct facts.
- The wall-clock budget starts at Case creation and includes queued time, pauses and repair rounds. Admission rejects expired engineering/worker turns, stage dispatch, check execution and new publication. The runtime checks active Cases at startup before resuming pending tasks and then after each sweep with a one-second delay. It persists human handoff, cancels and drains owned Session work, terminates tracked worker processes and queues the existing per-reporter handoff outcome. Notification delivery does not block later budget sweeps; uncertain sends keep their ordinary reconciliation rules.
- Attempts already ready for human review are exempt from automatic time expiry. A concurrent completed Attempt or changed Case revision prevents a stale sweep from transferring ownership. Cleanup failures are logged and retried; detection and OS cleanup latency mean this is not a real-time CPU limit. Model-token accounting and total worker limits still need implementation and verification.

Before upgrading, inspect old active Cases and configure the intended `maxCaseMinutes`: the default applies to their original creation times immediately at startup. No timestamp migration or budget reset occurs. After exhaustion, inspect the retained work and increase the installation budget before explicitly resuming; a resume without more time remains ineligible and returns to human handoff. Run `bun run test test/oryn/worker-start.test.ts test/oryn/shell.test.ts test/oryn/publish.test.ts -t 'budget|expired'` from `packages/synergy` for admission, cancellation, actual background-process cleanup, handoff delivery, readiness races and publication denial.

## Delivery Check Gating

Worker completion does not imply verified behavior. Reproduction and verification claims must reference the reporting assignment’s actual runs, with matching source and approved plan; delivery requires an independent verifier report. Environment failures remain inconclusive. See [report evidence validation](../decisions/implemented/bug-fix/2026-09-08-oryn-report-execution-evidence.md) for the guarantees and remaining authenticity limits.

Engineering must obtain `reviewRequirements` from `oryn_case get` after freezing a candidate and dispatch a separate reviewer for every required domain. The Host calculates the minimum from cumulative Case changes, including deletions; a general review cannot substitute for a required specialist. Keep the original baseline and candidate objects and the assigned code worktree available through delivery. Run `bun run test test/oryn/review-policy.test.ts test/oryn/publish.test.ts test/oryn/review.test.ts` from `packages/synergy` when validating review-policy changes.

A review-policy upgrade invalidates existing review fingerprints without rewriting their historical reports. For an active frozen candidate, request new reviewer Assignments with fresh request keys under the new binary; replaying an old review key fails. Acknowledged remote publications remain historical facts, while ready notifications recheck the current gate. Already-ready or unresolved publications require operator reconciliation before further automation; do not clear receipts, fabricate new fingerprints or roll back to an older policy to bypass review.

The `oryn/delivery` check run is written only when `oryn.repositories[alias].deliveryCheck` is `true` (default `false`). Follow this sequence when turning it on:

1. On an explicitly authorized test repository, enable `deliveryCheck: true` while leaving the check out of branch protection. With the flag false, no check is written and a canary cannot verify it.
2. Exercise the gated publication path and verify the check appears on the candidate SHA under the expected App identity. Verify the same PR becomes ready for review. The transport performs the GraphQL Draft-to-ready transition independently of the optional check flag, validates the returned candidate, and only then writes the enabled check.
3. After complete pipeline acceptance, enable the check for the target repository and register it as required with the expected App identity if branch protection requires it.

Never register `oryn/delivery` as a required check before the deployment has observed it run for real; a required check that the App cannot write blocks every PR on the branch.

Readiness is tied to a Case-owned PR, frozen candidate SHA, branch/base and the configured App identity. The publisher records the PR target before dispatch. A lost response is reconciled from the remote non-draft PR and, when enabled, its App-owned delivery check; unresolved or changed candidates pause instead of replaying writes. Successful settlement restores the attempt outcome and deduplicated per-source notifications after interruption. CI observation includes pending checks and paginated check results; the App's own delivery check is excluded from independent CI.

GitHub's ready mutation has no expected-head parameter. The transport checks the head before and in the mutation result, but it cannot make the remote transition atomic with concurrent pushes. Required checks and human review must remain tied to the current head. Publication receipts pin the Attempt and repository/base/check settings; changes leave unresolved actions for reconciliation. Review-policy changes during unresolved publication require operator reconciliation before resuming automation.

## Learning write recovery

Learning tools require an active, unexpired Case and its current engineering root or worker assignment. Paused, human-owned, cancelled and closed Cases, archived sessions and workers from replaced epochs or Attempts cannot submit or withdraw lessons. For corrections after Case ownership ends, use the authorized Library management surface, or explicitly resume the Case before using engineering tools. See [learning ownership](../decisions/implemented/bug-fix/2026-09-08-oryn-learning-ownership.md).

Keep `oryn.learning.verifiedMemory` disabled until lesson provenance and applicability have been reviewed for the deployment. Promotion requires an active Case with a current ready Attempt, acknowledged publication and a fresh successful remote delivery check. It refuses stale, draft, closed or failed deliveries through the shared ready verifier; a pending embedding request does not block Case pause or handoff. A changed delivery snapshot prevents the prepared memory from being committed. These checks establish delivery eligibility, not semantic truth, redaction of arbitrary lesson text, merge or release availability. See [learning delivery checks](../decisions/implemented/bug-fix/2026-09-08-oryn-learning-current-delivery.md). When enabled, promotion derives one memory identity per learning candidate and reuses an identical existing Library row after interruption. Withdrawal removes that row even when its insertion acknowledgment was lost, and concurrent promotion cannot overwrite a completed withdrawal. Conflicting Library content or an unavailable writer leaves the operation unresolved rather than deleting unrelated knowledge or claiming successful removal. See [learning write recovery](../decisions/implemented/bug-fix/2026-09-08-oryn-learning-write-recovery.md).

New proposals require accepted records from the active Attempt. The Host records repository, epoch, baseline/candidate commits, acceptance criteria and an evidence digest. A proposal made before candidate freeze or superseded by evidence changes needs to be proposed again with current evidence; it cannot silently inherit another delivery. Stored lesson and applicability text are explicitly model-authored proposals, not proof of general validity. See [learning provenance](../decisions/implemented/bug-fix/2026-09-08-oryn-learning-provenance.md).

The `20260908-oryn-learning-provenance` startup migration preserves each legacy memory's exact text and leaves unknown Host provenance absent. Historical candidates without that provenance are skipped by automatic promotion. Review existing Library memories explicitly; migration preserves them for reconciliation and withdrawal, and does not endorse their claims. Acknowledged historical `memoryRef` values are preserved. Before upgrading an installation that already enabled learning, reconcile any old unacknowledged random-ID Library insertions: their IDs were never recorded, so the new deterministic identity cannot identify them. Back up Oryn records and the Library database consistently. Run `bun run test test/oryn/learn.test.ts test/library/oryn-memory.test.ts` from `packages/synergy` for fault recovery and actual Library insertion/replay/removal with simulated embeddings. These tests establish storage behavior, not semantic truth or release availability.

Oryn memory embedding reads the installation's `embedding` settings in `00-general.jsonc`. An API key selects the configured remote embedding service; otherwise it loads the bundled local model using the installation's download-source and cache settings. Project overrides cannot choose this operation's endpoint, credentials or local extractor, and background recovery does not require a project Scope. Ordinary project embedding keeps its separate Scope behavior. Global embedding reload and runtime shutdown release both local instances. See [installation embedding](../decisions/implemented/bug-fix/2026-09-08-oryn-installation-embedding.md).

## Backup and Recovery

Oryn JSON records live under `$SYNERGY_HOME/.synergy/data/oryn/`. `SYNERGY_HOME` is the parent home; the runtime appends `.synergy`, as defined in [Storage and paths](../reference/storage-and-paths.md). The logical storage keys are:

- `oryn/cases/**` — cases, attempts, assignments, runs, reviews, reports.
- `oryn/actions/**` — the external action ledger (authoritative for reconciliation).
- `oryn/claims/**`, `oryn/sources/**`, `oryn/outbox/**` — intake and delivery state.
- `oryn/session_source/**` — host-owned session bindings.

Outbox schema version 2 distinguishes definitely unsent `pending` entries from `ambiguous` dispatches. The central upgrade migration preserves confirmed receipts and marks old pending entries ambiguous because their send history is unknown. Do not reset ambiguous entries to pending during recovery; first obtain authoritative provider evidence or reconcile manually. The older binary cannot safely read these delivery semantics; a rollback needs a consistent pre-upgrade backup and review of any subsequent remote writes.

Use a consistent backup of the dedicated runtime root, including its `data/` and configuration, with the same cadence as the rest of the runtime. Oryn does not have an independent transactionally consistent backup. Recovery rules:

- Replayed submissions dedupe to the same Case. Startup repairs reserved worker creation, missing Session indexes, registered worktree binding and pending task delivery; it validates repository/source policy before replay. Ambiguous external actions settle through reconciliation against remote facts (App author, case marker, head SHA) instead of blind replay.
- Test worker creation recovery with `bun run test test/oryn/worker-start.test.ts` from `packages/synergy`. It injects persistence interruptions and captures scheduling; the scripted success/repair suite separately verifies actual worker execution. Already consumed tasks are not delivered again. Consumed interrupted turns resume through bounded Session steering. Git worktrees created before their registry write still require operator inspection; do not interpret these tests as complete crash recovery.
- Never restore a partial `oryn/` subtree alone; restore the storage directory as a unit so ledger, claims, and case records stay consistent.
- Session bindings reference session IDs; restoring data without the sessions directory leaves orphaned bindings, which the host treats as unbound (fail-closed) rather than re-binding automatically.

## Disable and Rollback

Set `oryn.enabled: false` (or remove the `oryn` key) and restart the runtime. Disabled behavior is a product invariant: no Oryn agents, tools, routes, or poll additions execute, and ordinary Channel/Boss/Feishu/GitHub behavior is unchanged. In-flight external actions recorded before the flip are reconciled on the next enabled window; a case left mid-flight stays paused-safe and requires a human to resume.

## Generated publication content

Oryn builds issue and PR bodies from Case observations, actual frozen Git changes and accepted assignment reports. PR titles use a conventional type. Tool-provided body text is bounded implementation commentary, separate from host evidence; it does not replace evidence sections. The Mermaid scope map depicts changed files between base and candidate, not runtime dependencies. Commands containing recognized private context are omitted; raw logs remain in the authorized workspace. Public text checks reject known credential and local-path patterns but are not a general personal-data classifier.

Draft-to-ready refreshes the PR description with current accepted verification and review before changing GitHub readiness. A transport failure after an attempted write is reconciled as an uncertain action, not blindly repeated. Evidence display is not proof that the full feedback pipeline, application behavior or live Feishu canary has passed.

## GitHub installation and backfill

For GitHub intake, verify the App is installed on the target owner and selected repository, not merely registered with valid credentials. Open-object backfill uses an unfiltered timestamp range; incremental polls retain their own watermark. After upgrading an installation that incorrectly completed an empty backfill, disable and save `backfill`, then enable and save it to request another complete scan. Existing thread identities deduplicate replayed work.

## Optional GitHub labels

Set `oryn.repositories[alias].labels: true` in the installation config to enable label projection. It defaults to false. `defaultPriority` optionally selects the initial `p0`–`p3` label; leave it unset for `untriaged`. Existing `oryn:priority/*` labels are preserved, including priorities set by humans. Priorities on the issue and PR remain independently editable; this feature does not overwrite one with the other.

The ordinary GitHub poll drives a bounded rotation of active Cases. The Host derives type and progress from current assignments/Attempt, and the provider verifies the App author, Case marker and pinned PR head/branch/base before writing. Only known Oryn type/status labels are replaced; other labels remain. Paused, taken-over, cancelled and closed Cases receive no new label writes. A label is a progress display, never a delivery check or merge permission; external head changes still require the engineering lifecycle to invalidate the candidate.

Prepare label definitions on the authorized target before enabling this setting. From a trusted Oryn source checkout, with `bun`, `gh` and `rg` available, the following bootstrap preserves definitions that already exist. Replace the repository placeholder and run only with an account authorized to configure that repository:

```bash
set -euo pipefail
ORYN_TARGET_REPO=owner/repo
ORYN_LABEL_TMP=$(mktemp -d)
trap 'rm -rf "$ORYN_LABEL_TMP"' EXIT
bun -e 'import { OrynLabel } from "./packages/synergy/src/oryn/schema"; console.log(OrynLabel.options.join("\n"))' > "$ORYN_LABEL_TMP/desired"
gh label list --repo "$ORYN_TARGET_REPO" --limit 1000 --json name --jq '.[].name' > "$ORYN_LABEL_TMP/existing"
while IFS= read -r label; do
  if ! rg --fixed-strings --line-regexp --quiet -- "$label" "$ORYN_LABEL_TMP/existing"; then
    gh label create "$label" --repo "$ORYN_TARGET_REPO" --color 64748b --description 'Oryn progress metadata; does not grant execution or merge authority'
  fi
done < "$ORYN_LABEL_TMP/desired"
```

Each attempted update has a `sync_labels` ActionReceipt with schema version 4 and a fixed target. A lost response is reconciled from current remote labels; replay applies only the remaining delta. After three unsuccessful apply attempts for the same projection, label writes stop while the Case continues. Inspect the receipt and repository permissions/definitions, then apply the intended labels manually; a later poll acknowledges a matching remote result. A subsequent changed projection has its own bounded intent. A superseded intent is cancelled locally; this does not roll back label requests already sent.

Run `bun test test/oryn/labels.test.ts test/oryn/action-migration.test.ts test/channel/provider/github/oryn-labels.test.ts` from `packages/synergy` for local verification. These fixtures mock GitHub transport; they do not establish live App permissions. Updating one label at a time can temporarily show both old and new stages during synchronization; the acknowledged projection contains one known type and one known status.

Run `bun run test test/oryn/worker-start.test.ts` from `packages/synergy` for reserved-worker and consumed-turn recovery. The suite includes repeated interrupted recovery, explicit pause/resume, engineering report consumption, a scripted model completing through the actual result tool, and a held engineering lease during Host handoff. Fixtures preserve the same task root and worker; they simulate interrupted durable state within an isolated test runtime rather than killing and restarting the complete server process.

Run `bun run test test/oryn/process-restart.test.ts` from `packages/synergy` to start an isolated server and real Agent worker processes, submit two concurrent mock Feishu topics, kill the owned process group and restart with the same durable home. The two scenarios interrupt worker model requests and Issue creation before acknowledgment. They assert task identity, original Issue linkage, correctly anchored human handoffs and replay without duplicate replies. This fixture uses loopback external services and performs no live publishing. The native Ubuntu CI runs it without Docker alongside the successful scripted PR pipeline.

For an orphaned publication, retain its request key and receipt. Engineering replay or GitHub polling discovers remote artifacts and repairs missing Case links; never delete the receipt to force another creation. Unknown numbers require a complete scan of at most ten pages of App-created repository Issues, including PRs. Multiple matching markers, an incomplete scan or three failed observations leave the action uncertain and pause the Case for inspection. See [publication crash recovery](../decisions/implemented/bug-fix/2026-09-08-oryn-publication-crash-recovery.md) for the guarantees and limits.

Run `bun run test test/oryn/attempt-transition.test.ts test/oryn/review.test.ts` from `packages/synergy` to validate interrupted Attempt rotation and ordinary review/rework. Backup the full Case subtree, including `attempt_transitions`; removing its intent can lose the reserved replacement identity and counter effects. Startup pauses a Case when an unfinished transition conflicts with its current revision. Inspect the transition and intervening acceptance/control changes before further automation.

An explicit resume from human-owned or cancelled control starts a fresh Attempt using the prior frozen candidate or pinned baseline. It preserves repair counters and historical evidence, keeps old workers invalid and creates a new engineering task. Pause/resume preserves the current Attempt. A persisted resume interrupted before task delivery recovers through the same startup path; until that task exists, engineering execution remains suspended. Resume does not import remote human edits or resolve missing acceptance/environment decisions. Run `bun run test test/oryn/worker-start.test.ts test/oryn/attempt-transition-migration.test.ts` from `packages/synergy` for lifecycle, migration and scripted model verification.
