---
name: change-channel-runtime
description: Add, modify, or review Synergy Channel targets, provider lifecycle, managed Project ownership, ChannelHost Scope/Session routing, native Clarus task handling over Holos, durable result or extension delivery, Channel diagnostics and routes, or Channel account navigation. Use across packages/synergy/src/channel, adjacent Holos/Session/Agenda/server owners, generated SDK contracts, and packages/app Channel surfaces.
---

# Change the Channel Runtime

## Trace the Contract

1. Read [Channels](../../../docs/architecture/channels.md), [Sessions and messages](../../../docs/architecture/session-and-messages.md), [Connections](../../../docs/product/connections.md), and the nearest package `AGENTS.md` files.
2. Identify the provider's conversation, Project, and Task ingress capabilities independently, and classify its lifecycle as `self_connected` or `borrowed_transport`.
3. Trace target identity, provider configuration, account start/stop/status, `ChannelHost`, managed ownership, Session endpoint lookup, inbox delivery, navigation projection, routes, generated SDK consumers, diagnostics, and recovery state.
4. Load `change-persistence` for ownership, indexes, provider-private state, or outboxes; `change-server-api` for routes or generated contracts; `develop-frontend` for account/navigation UI; `add-tool` for first-party Channel tools; and `develop-synergy` for isolated runtime verification.

## GitHub Channel Provider

The `github` provider (`packages/synergy/src/channel/provider/github/`) connects a GitHub App installation as a conversation channel. It is `self_connected` and polls the GitHub REST API outbound — no inbound webhook.

- **Conversation ingress only** — synthesized repository events (`issue.opened`, `pull_request.opened`, `pull_request.synchronize`, `comment.created`) flow through `ChannelHost.conversations.receive()` with `chatId = "owner/repo#<number>"`.
- **Per-thread Scope** — implement `resolveConversationScope()` to bind each thread to its own random-hash checkout directory (see `GithubChannelWorkspace.ensure()`), so sessions are isolated per issue/PR. `workspaceDir` is configured per account.
- **Mention gating** — comments only wake an agent on an explicit `@synergy-agent` mention (`gateGithubEvent`); `autoReview`/`autoRespond` account toggles gate PR and issue events.
- **Reactions** — `addReaction` maps the generic channel emoji vocabulary onto GitHub's reaction content set (`eyes`/`rocket`/`confused`/`+1`/`-1`/`laugh`/`hooray`/`heart`) via a comment→chatId registry populated by the poll loop; unsupported emoji are skipped.
- **Agent** — `github-channel-agent` owns all GitHub sessions; `gh`, `git push`, and `git remote` are denied (the provider performs all GitHub writes with an installation token).
- **Credentials** — `SYNERGY_GITHUB_APP_ID` / `SYNERGY_GITHUB_APP_PRIVATE_KEY` env-only; distinct from the user-credential `src/provider/github.ts` (bash `GH_TOKEN` injection).

Preserve these invariants when changing the provider: deterministic per-thread directory resolution, `@synergy-agent` mention gating, comment→chatId reaction registry, and the env-only credential boundary.

For Oryn publication changes, verify actual remote state transitions through a fake HTTP boundary around the production transport, alongside real Host ledger tests. A check-run response does not prove a PR left draft; GraphQL HTTP 200 can contain errors. Include pending/paginated CI, exact App identity, changed head, response loss and replay without duplicate notifications. Keep independent CI separate from the delivery check itself.

## Preserve Ownership

1. Keep Scope and Session creation in Channel core. A project/task-capable provider reports remote facts through `ChannelHost`; it does not call Scope, Session, or model execution directly.
2. Use typed `ChannelTarget` identity for new chat, Project, and Task endpoints. Preserve existing Feishu legacy endpoint keys, default Home-Scope behavior, and configured project Scope routing byte-for-byte.
3. Keep Project targets as ownership/navigation identity only. Discovery and Project-level events must not create a Project conversation Session or invoke a model.
4. Map each external Project identity to one canonical managed Project Scope with hashed forward and reverse ownership indexes. Keep raw external IDs out of path components, reject path escape and symbolic links, keep the managed workspace non-Git, and never remove a Scope in response to remote archive.
5. Map one external Task ID to one stable unattended Session in its managed Project Scope. Deliver assignments and updates through the persistent inbox with deterministic delivery keys; keep participation and deadline guidance hidden and system-authored.

## Preserve Native Clarus Semantics

1. Borrow the existing authenticated Holos Agent Tunnel through `HolosRuntime.getNativeTunnel()`. Do not add another WebSocket, transport reconnect loop, credential owner, daemon, or Holos server change. Provider initialization may retry through Channel's bounded backoff after borrowed transport readiness.
2. Validate account identity, process epoch, connection generation, event schemas, request correlation, and acknowledgement identity at the transport boundary. Dispose observers and in-flight work on account stop or transport replacement.
3. Clarus emits only Project and Task ingress. Treat `clarus.project.membership.accepted` only as a hint to repeat authoritative Project discovery and correlated subscription; never grant ownership from that payload or from an Assignment `project_id`. Keep subscription state and runtime Task events as the remaining accepted event families, and classify legacy Project message, file, system, and notary events as unknown without Session delivery.
4. If Task dispatch reports missing managed ownership, allow one bounded authoritative Project refresh and one retry while preserving `ChannelHostProjectNotOwnedError` and the archive guard. Do not create a Scope or Session from Assignment identity alone.
5. Send `clarus.runtime.task.accept` only after preflight, Session binding, assignment persistence, and deadline synchronization, immediately before first wake. Persist `acceptState`, stable `acceptRequestID`, and `acceptedAt` on the existing Assignment record; parse old records with `acceptState: none` and do not add a migration or outbox. Exact replay must validate managed ownership, the bound non-archived Session, and request/run/Project/Task/subtask/attempt identity before bypassing `ChannelHost.dispatch`: acknowledged replay is a full local no-op, live pending replay sends nothing, and ambiguous or orphaned persisted pending replay only resends accept with the same request ID. Let correlated `runtimeTaskAccepted` bypass generic in-flight suppression and settle only on matching request ID plus all five task identity fields. Late acknowledgement may upgrade ambiguous state, and acknowledged state must never regress on transport failure.
6. Persist result and extension outbox records before dispatch. Only `not_dispatched` may retry automatically with a fresh request ID and lineage; `rejected`, `ambiguous`, and `acknowledged` are terminal for automatic retry. Recovered `pending` records become `ambiguous`.
7. Keep remote Project pause as display/protocol state for already accepted work. Use the standard Session Abort path for local cancellation, and keep accepted-task result, extension, and deadline behavior available while remotely paused.
8. Use Agenda `session_guidance` only for durable hidden steering into the owning Task Session. Clarus deadline guidance fires once exactly three minutes before the current deadline, fires as soon as safely possible when less time remains, does nothing after expiry, and reuses the same Agenda item after an acknowledged or authoritative extension. It must not create an Agenda execution Session or a visible fake user prompt.
9. Keep `clarus-agent-participation` available as a memory-backed builtin Skill in a fresh `SYNERGY_HOME`. Its content must describe only the native assignment Session and result/extension tools; do not bundle standalone listener, CLI, daemon, credential, or second-WebSocket workflows.

## Keep API and Product Projection Complete

1. Add precise route schemas and OpenAPI metadata for Channel account actions, then regenerate the SDK and migrate ordinary Web calls to generated methods. Keep diagnostics downloads on the established file/blob path.
2. Bound and redact durable diagnostics before persistence and export. Never expose credentials, auth headers, raw local paths, or unbounded prompt/result payloads.
3. Project managed Projects once under the owning Channel account from canonical Scope/Session navigation state. Do not add a provider-specific Project store, duplicate generic Projects, or a dedicated Clarus hierarchy.
4. Present provider-capability actions, account and remote Project states, semantic icons, keyboard access, localized labels, and archive-guard guidance through shared components.
5. Update [Channels](../../../docs/architecture/channels.md), product connection/workspace docs, storage paths, and `packages/app/PRODUCT.md` when their contracts change.

## Verify

1. Write the smallest failing behavioral test first. Use real temporary Scope, Storage, Session, inbox, Agenda, and filesystem state; fake only Holos/Clarus network boundaries.
   For Oryn conversation changes, use `test/oryn/fixtures/feishu.ts` with real `ChannelHost.conversations.receive()`, tool parsing, Inbox and outbound events. A direct service call cannot prove agent selection, per-root reply targeting, or silent foreground/background delivery; include these paths and label synthetic model output separately from a live canary. For Case intake, send a second message in the same topic and submit through the actual tool with its persisted assistant/root context. Verify both the Case source and eventual reply anchor, replay deduplication, same-session get/list and cross-session denial. A test that only submits on the first message misses Session-anchor reuse.
2. When Channel behavior depends on Scope-local subscriptions, cover both the first account connection and `ScopeRuntime.dispose()` followed by `ScopeRuntime.ensure()`; an active account must rebind its bridges exactly once before startup recovery can terminalize pending Channel messages, so recovery-time events are delivered rather than lost.
3. Run the focused Channel, Holos native tunnel, Session endpoint/navigation, Agenda guidance, tool, server route, and frontend account/navigation tests affected by the change.
4. Run `bun test test/channel/` and the relevant Holos, Agenda, Session, tool, and server suites from `packages/synergy`; preserve Feishu compatibility coverage.
5. For route changes, run `./script/generate.ts` twice and confirm generated OpenAPI/SDK output is stable. Run App/UI tests, localization checks, typecheck, build, Skill validation, and `bun run quality:quick` as applicable.
6. Exercise the protocol in an isolated second runtime with a separate `SYNERGY_HOME` and explicit ports. Verify disabled and zero-Project idle behavior, discovery, one Task Session per Task ID, result/extension settlement, reconnect recovery, diagnostics download, and cleanup without using the active runtime.

## Handoff

Report provider shape and lifecycle, target identity, Scope/Session ownership, durable state and recovery semantics, routes/SDK/UI wiring, focused and broad checks, isolated runtime evidence, and any environment-only limitation.

## Oryn public evidence

When changing Oryn publication, exercise `test/oryn/publication.test.ts`, `test/oryn/publish.test.ts` and `test/channel/provider/github/oryn-publish.test.ts`. Create a real nonempty candidate commit in successful fixtures; verify that current accepted assignments supply evidence, private context cannot enter public text, and ready refreshes the body before the remote transition. The delivery gate must inspect the generated body that is actually published, not a separate model-authored payload. Distinguish a Git diff scope map from a verified runtime architecture diagram.

Derive mandatory review domains from Host-verified cumulative Case changes, including deleted paths; do not let an engineering agent omit a risk domain by omitting its Assignment. When changing those rules, bump the review policy version and test old Assignment/report rejection plus successful fresh review. Preserve historical records without backfilling their fingerprints. Successful-review fixtures use the current Host fingerprint builder; explicit legacy fingerprints belong in rejection tests. Include a repair whose latest diff is ordinary but whose full PR still changes a sensitive path; run `test/oryn/review-policy.test.ts` and `test/oryn/review-handoff.test.ts` alongside publication and review tests.

For Oryn labels, run `test/oryn/labels.test.ts`, `test/oryn/action-migration.test.ts` and `test/channel/provider/github/oryn-labels.test.ts`. Verify installation opt-in, exact Case/PR identity, paginated human priority preservation, pre-write epoch checks and interrupted-intent reconciliation. Use GitHub add/remove label endpoints; never replace all labels or let labels grant execution authority. Keep label failures out of the engineering pause path.

Cover both App-owned and Host-tracked contributor objects, including forks, queued/draft PRs and revoked repository bindings. Keep emoji display names in the shared label catalog while persisted receipts use stable IDs. Verify canonical legacy names and emoji names both converge without duplicate writes or priority loss.

For model-driven Oryn QA checks, use `test/oryn/fixtures/model.ts` with the product registration and real configured provider. Run `test/oryn/model-pipeline.test.ts` alongside ingress tests. Do not replace Session invocation or tool execution with scripted service calls; only provider/model transport is simulated. Wait for the owning Session to settle before asserting duplicate-event inference counts, and keep auxiliary model requests separate from QA requests.

For Oryn result notification changes, assert captured transport delivery, not only outbox creation. Hold the transport-readiness or observation boundary while changing Case control, acceptance, candidate or policy; validate again before claiming dispatch and do not hold Case locks across network calls. Test renewed conclusions after suppression, legacy delivered/ambiguous identities, current remote head/CI, and model replies reusing Host-generated result intents.

For credential-bearing Oryn Git changes, run `test/channel/provider/github/oryn-push.test.ts` and the Host publication suites. Exercise real Git push/receive-pack with only the HTTPS helper replaced by a test transport. Plant repository hooks, credential helpers and URL rewrites; include ambient Git/startup/credential settings, linked worktrees, actual non-fast-forward rejection and cancellation of the owned process group. Never return raw Git diagnostics or treat an interrupted push as proof that no remote write applied. Keep this isolation separate from the ordinary GitHub Channel credential helper.

For Oryn GitHub changes, keep repository-qualified source identity, independent backlog/incremental checkpoints and current-head review claims intact. Exercise real engineering Session admission alongside provider pagination fixtures. Check permission revocation, bot feedback suppression, uncertain-publication reconciliation and operator-target replacement. Follow [GitHub intake and setup](../../../docs/decisions/implemented/feature/2026-09-08-oryn-github-loop-and-setup.md); external review never substitutes for delivery verification.

Backfill provider fixtures must inspect the outgoing timestamp filter as well as pagination. Omit `since` for all-history open-object scans instead of encoding a sentinel date; preserve the exact watermark for incremental scans. A connected App identity alone does not establish repository installation access.

For Feishu group discovery, run `test/channel/feishu-projects.test.ts` and `test/oryn/setup.test.ts`. Require complete bounded pagination before negative reconciliation; verify permission errors, repeated cursors and cancellation preserve existing ownership. Discovery must not create conversation work or change legacy Feishu Scope routing. Keep provider refresh capability, Settings actions and sidebar capability tests aligned.
