# Decision Record: Oryn external-action ledger and the credential-isolated publish transport

Status: implemented

## Problem

Oryn writes to remote GitHub state — tracking issues, candidate branches, draft pull requests, review comments, check runs. Network writes have no transaction: a timeout, crash, or deploy between "request sent" and "response received" leaves the outcome unknowable from inside the runtime. Replaying blindly risks duplicate issues and PRs; skipping risks a published artifact the pipeline never learns about. Separately, every worker shell historically risked credential leakage because the Bash tool injects GitHub tokens into `gh`-capable environments — a worker that never calls `gh` could still reach the token through `curl` or a script. The pipeline needed a write path where the outcome is always eventually known, duplicates are structurally impossible, and model-reachable code paths never see a credential.

## Decision

Every external write is a two-phase, ledger-first action. `OrynPublish.publish` records an `ActionReceipt` (`prepared`) before any transport call, flips it to `in_flight`, and settles it to `acknowledged`, `ambiguous` (transient failure: abort, API error, timeout), `rejected` (deterministic failure), or `cancelled` (epoch or control change raced the preparation). A pre-flight re-check cancels the action if a human takeover or cancel slipped in between preparation and execution. Ambiguous actions are settled only by bounded reconciliation (`OrynPublish.reconcileAmbiguous`): remote facts — author is the App, the hidden case marker is present in the body, and for pushes the head SHA equals the expected candidate — must agree before a receipt is acknowledged. Uncertainty after the bounded attempts pauses the case (fail-closed); it never replays. A remote head that moved without Oryn cancels the action and freezes the case so automation cannot race the human's push.

The transport layer is provider-owned and holds the only credential access. The oryn domain programs against an injected `PublishTransport` interface (wired in `product-registration.ts`), so it never imports the provider and can never touch tokens. Pushes are SHA-pinned fast-forward pushes (`<sha>:refs/heads/<branch>`): GitHub rejects diverged heads without `--force`, which the transport never passes, so a non-fast-forward is a deterministic rejection (`PublishNonFastForwardError`) rather than an ambiguous state. Public branch names and case markers derive from a hash of the case id, never the raw internal identifier. Case-level idempotency is verified against remote facts before creating anything: an `ensure_issue` replay observes the recorded issue and refuses to create a duplicate if the marker or author does not match, and `ensure_draft` after a published PR requires the head to still match the frozen candidate. `mark_ready` runs the full delivery gate with CI observed remotely, optionally writes the config-gated `oryn/delivery` check run, and queues exactly one `ready` notification through the durable outbox. Reconciliation runs on the existing GitHub poll loop cadence — no second scheduler.

Worker credential isolation is enforced at the spawn boundary, not by convention: the Bash tool strips GitHub and SSH agent variables for `oryn-*` agent sessions before the child environment is built, so no `curl`, script, or credential-helper path can reach the token, and the behavior is pinned by a dedicated regression test.

## Alternatives considered

**Idempotent remote operations only (client-generated keys, upserts).** GitHub has no idempotency keys for issue/PR creation; content-hash upserts degenerate into "search then maybe create", which is itself a read-then-write race across restarts. The ledger makes the intent durable first, so the worst case is always a settle, never a double-create.

**Replay ambiguous actions with backoff.** Rejected: replay after an unknown outcome is exactly how duplicate issues and surprise pushes happen. Reconciliation asks the remote what happened; replay assumes it did not.

**Scope credentials to the model via a allowlisted `gh` wrapper.** Rejected as insufficient alone: a string-level deny or a wrapper controls one path while the token remains reachable from any other subprocess. Environment stripping at spawn closes the whole class; the ledger-plus-transport design means the model never needs a token for publishing at all.

**Write reconciliation into a dedicated scheduler service.** Rejected: the GitHub poll loop already runs per repository on a healthy cadence with backoff and error isolation; hanging a reconciler there adds zero infrastructure and inherits the same lifecycle.

## Consequences

Every remote write is auditable from the `oryn/actions/` storage prefix, and a crash at any point converges to a settled receipt. The cost is that `mark_ready` is only as fresh as the last reconciliation: a case paused by unresolved ambiguity requires a human (or a later confirming observation) to resume. Marker-based settlement means a human editing an Oryn-authored body can strip the marker; the next observation then reports the mismatch and pauses the case rather than guessing. The config-gated `deliveryCheck` keeps the check run off by default so a deployment never registers a required check the App cannot yet write.
