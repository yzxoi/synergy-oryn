# Decision Record: Oryn Feishu ingress and explicit reply delivery

Status: implemented

## Problem

Oryn tools require a QA source binding, but ordinary Channel ingress did not create one or select the Oryn agent. A service-only outbox test did not exercise the provider lifecycle, and no production transport was installed. Reusing ordinary terminal delivery would send internal task output alongside intentional QA replies. Binding every response to the Session's latest incoming message would also misroute delayed answers within a busy thread.

## Decision

Channel core resolves configured Oryn Feishu routes before Runtime Boss aggregation. Group routes require the existing `group_thread` provider scope. Their endpoint scope keys have an Oryn namespace, preserving ordinary conversations and preventing account opt-in from reusing an existing ordinary agent history. Channel core selects the QA agent and persists its immutable source binding before accepting the first task. The provider retains ownership of Feishu thread normalization and remote replies.

Every accepted Oryn root has a `channel_turns` record pointing to a `channel_sources` record with its original message anchor, chat type, provider scope key, and QA Session. These are new version 1 records under the existing Oryn storage domain; no existing Session or endpoint record is rewritten. The reply tool derives the root from persisted messages, and the service verifies that the recorded turn belongs to the QA source. Later incoming messages do not overwrite earlier reply targets.

The Case tool resolves the calling root from canonical message fields and passes it as Host context, outside model parameters. Intake uses that root’s durable Channel source for the claim and Case anchor. Missing or foreign roots are rejected for Channel-bound QA. The initial Session binding remains immutable; Case get/list/amend and replies also accept linked sources recorded for that same QA Session and matching provider/account/chat/thread. Lists derive from the existing turn records, with no new persistent index or schema. Older Cases retain their original source rather than guessing which later message initiated them.

Oryn foreground delivery uses a silent stream and suppresses status reactions, automatic response cards, attachments and terminal text. The global outbound bridge recognizes the persisted QA binding and drains only explicit reply intents. Feishu connection recovery also requests a drain. Channel assembly installs the provider-owned reply transport with a connection and configured-route readiness check; disconnected sources remain pending. The outbox's uncertain-send rules still apply after transport invocation.

## Alternatives considered

**Only configure the account's default agent.** Agent selection alone provides neither source ownership nor per-root reply anchors and leaves automatic terminal delivery enabled.

**Aggregate Oryn messages into the account's Runtime Boss Session.** This loses independent QA topic contexts and couples unrelated reporters to one conversation history.

**Mock OrynService without entering ChannelHost.** Such tests miss routing, agent selection, Inbox acceptance, lifecycle wiring and terminal-output leaks. The Feishu fixture replaces the remote provider boundary while using real Channel, Session, tool, Bus and Storage behavior.

## Consequences

The repeatable ingress test covers two topics, duplicate events, follow-up answers and Case submissions on their original message anchors, repeat submission deduplication, same-session Case listing and cross-topic read denial, real reply-tool execution, completion-triggered delivery, silent internal terminal text and an unlisted ordinary chat. It uses synthetic assistant output rather than a model API and does not prove live Feishu behavior or the engineering-to-GitHub chain. Existing Boss and Channel outbound suites verify adjacent delivery behavior.
