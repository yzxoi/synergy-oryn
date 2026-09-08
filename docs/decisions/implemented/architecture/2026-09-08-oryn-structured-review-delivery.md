# Decision Record: Oryn structured review delivery and domain checks

Status: implemented

## Problem

Structured reviews were persisted without waking their engineering Session, and the model result tool could not read them. Replaying a request appended another review before assignment acceptance failed. Paused and replaced work could still accept judgments. Delivery used only the latest review, allowing a later general review to hide a security blocker or an unaccepted report to influence the result.

## Decision

Review submission is serialized with Case control. The Host validates the bound worker, stage, domain, candidate, baseline and assignment input digest. A request derives a stable review identity from the Case, Assignment and request key; retries preserve the original record and reject changed content. Report creation, Attempt linkage, assignment acceptance and Inbox delivery remain separate recoverable writes. The report format stays at version 1, and existing historical IDs remain readable without migration.

`OrynReports` delivers accepted worker and review results through one durable Inbox identity. Runtime startup repairs accepted reports whose event delivery was interrupted. An existing runnable event is woken again, while an already-consumed event is not recreated. Inactive control, replaced Attempts and old epochs cannot generate new result events. This is recovery through the existing Inbox, not a new execution queue.

Engineering tools expose the current candidate, receipt IDs and bounded review references. The result tool reads formal reviews as well as worker judgments; `oryn_check` has a role-restricted `get_run` action for actual receipts. A plan alone does not prove execution, and QA cannot read raw run receipts through this action. Reviewer prompts explain these reads, stable retries, domain ownership and formal result submission.

Boss task-report providers return undefined when they do not own a task. An owning provider's false result requires a structured outcome even when the worker already called ordinary `boss_report`; true finishes or quiesces its task. Oryn uses this to stop invalidated work and to prevent free-text notes from completing reviewer assignments. Ordinary Boss tasks retain their existing report behavior.

The delivery gate considers accepted reviews only, bound to current review Assignments. It requires a general review and every review domain assigned on the Case, selects the latest accepted result within each domain by durable Attempt report order, and checks candidate/base, acceptance, evidence references and assignment inputs. Any domain's open blocker, unresolved question or owner decision blocks ready. Submission carries open findings within the same domain, including a repeat review on the same Attempt; other domains cannot silently clear them.

## Alternatives considered

**Require a second natural-language report.** This makes workflow progress depend on an optional extra model action and cannot recover an accepted report after interrupted delivery. The structured write drives the event.

**Accept the newest persisted review.** Persistence is not acceptance, and different domains cover different risks. Assignment ownership and per-domain aggregation preserve both distinctions.

**Create new records on every retry.** A lost response becomes a new judgment and can conflict with the accepted assignment. Stable identities make the original result replayable without changing its content.

## Consequences

Behavioral tests cover concurrent replay, consumed-event deduplication, interrupted acceptance and delivery, report/receipt reads, domain mismatch, paused work, changed acceptance, cross-domain blockers and structured completion. Existing Oryn/Boss tests preserve ordinary Boss behavior and worker handoff. Fixtures use temporary storage and leased Sessions without live model calls; legacy review pipeline fixtures still use synthetic check scenarios and do not prove trusted execution.

Evidence digests currently bind receipt references; complete receipt authenticity, policy enforcement, risk-derived required domains, bounded model budgets and GitHub check identity remain separate audit work. Historical free-text review notes do not satisfy formal review delivery. The complete feedback-to-PR system remains under integration review.
