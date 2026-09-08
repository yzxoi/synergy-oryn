# Decision Record: Oryn GitHub intake, independent reviews and setup

Status: implemented

## Problem

Repository feedback arrives through existing Issues, contributor PRs and engineering discoveries as well as Feishu. Treating each update as a new chat loses task identity, floods reporters and can publish an obsolete review. Operators also need to select the monitored repository and human notification destination without editing several policy files.

## Decision

The GitHub provider delegates explicitly enabled repository bindings to Oryn. Durable per-repository cursors advance only after Case admission. Incremental scanning and open-object backfill have independent page positions; overlapping windows and daily reconciliation repair movement between pages. A bounded rotation refreshes active and owned PRs. Host-owned thread identities include repository and number, and replay preserves the original Issue. Existing Oryn Issue/PR updates return to their engineering Session through Inbox.

External PRs create review work in existing Boss engineering Sessions. The Host fetches immutable Git objects through a private credential-bearing bare repository, then imports objects without credentials into the trusted checkout. Each required review domain runs independently on frozen base/head inputs. Review publication requires accepted current reports and a fresh remote observation; it emits a combined COMMENT review plus valid changed-line comments. It does not certify delivery. Publication is claimed under the Case lock before network dispatch; an uncertain result is reconciled by an App-authored marker and never blindly resent. Historical receipts are retained when the head changes.

Exact `@oryn review`, `@oryn fix` and `@oryn stop` commands require live repository write, maintain or admin permission. Repair adoption starts a separate Case at the contributor head and produces a separate PR, preserving its commits. Repository and account policy is checked again during execution and publication. Runtime merge, release and force-push remain unavailable.

Every Oryn role can record a discovery. Independent and blocking discoveries persist lineage before creating private reproduction work; an accepted reproduction is required before creating a public Issue. Current-change findings stay with the review. Environment and security classifications do not create public child work. Exact observations deduplicate locally; root wall-clock, depth and descendant ceilings bound recursion. Existing Session, Inbox, ToolScheduler and Storage mechanisms own concurrency and recovery.

The generated setup API exposes configured GitHub repositories and discovered Feishu chats/topics. The settings panel validates the trusted checkout and base ref, sets the default repository and explicit Feishu route, and selects an optional human notification target. Automatic review and backfill default on; automatic coding defaults off. Installation policy remains authoritative. GitHub-origin handoffs and ready results use the operator target; Feishu-origin feedback retains its reporter conversation.

The event/permission separation follows [OpenClaw's dispatch workflow](https://github.com/openclaw/openclaw/blob/main/.github/workflows/clawsweeper-dispatch.yml) and [Clawsweeper skill](https://github.com/openclaw/openclaw/blob/main/.agents/skills/clawsweeper/SKILL.md). Independent review and delivery separation follows its [autoreview skill](https://github.com/openclaw/openclaw/blob/main/.agents/skills/autoreview/SKILL.md). Oryn retains human merge and adapts those ideas to outbound polling. [GitHub review API semantics](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request) determine commit and line anchoring.

## Alternatives considered

**A separate coordinator service.** Rejected because Boss Sessions, durable Inbox and existing admission already provide execution ownership; a second queue would add competing recovery state.

**Mandatory incoming webhooks.** Rejected because the deployment has no public incoming address. Outbound polling can recover without requiring a relay.

**Modify a contributor branch or automatically merge a reviewed PR.** Rejected because review is not delivery proof and the contributor owns their branch. Authorized repair produces an independently verifiable PR for human merge.

## Consequences

An installation needs neither Docker nor an incoming GitHub endpoint. Native sandbox prerequisites and trusted execution profiles still apply to reproduction and coding; setup does not infer executable command permissions. Enabling a repository also authorizes its existing open backlog when backfill is selected.

Polling and capped comment snapshots trade immediate/full historical conversation replay for bounded work. The latest 100 combined issue comments, reviews and inline comments are observations, not an audit archive. Exact local discovery deduplication does not establish semantic equivalence with every remote issue; uncertain duplicates require human judgment. Blocking discovery records preserve the relationship but do not automatically merge dependencies. Root wall-clock and descendant limits do not constitute aggregate token accounting. Unknown publication outcomes may require operator inspection.

New records use versioned Oryn-specific storage namespaces; existing Cases and publication ledgers retain their formats. Tests cover real engineering Session admission, frozen-input invalidation, command authority, uncertain-review reconciliation, pagination, recursive discovery, setup validation and browser interactions. Scripted transport/model tests do not prove live GitHub App scopes or target-host readiness.
