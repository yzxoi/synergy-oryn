import { OrynPublication } from "./publication"
import { externalIdentityHash } from "../util/identity"
import { OrynStore, storeError } from "./store"
import { OrynConfig } from "./config"
import { OrynService } from "./service"
import { OrynLearning } from "./learn"
import type { ActionReceipt, PublishOperation } from "./schema"

/**
 * Host-side Oryn publish ledger. Every external write intent is recorded as
 * an ActionReceipt (prepared → in_flight → acknowledged / ambiguous /
 * rejected / cancelled) BEFORE the transport runs, so a timeout or crash
 * never loses the fact that an action was attempted. Reconciliation verifies
 * remote facts (author identity, case marker, head SHA) with bounded
 * re-checks; uncertainty pauses the case instead of replaying blind.
 *
 * The transport interface is injected by the product assembly so this domain
 * never imports the channel provider (the provider imports these types).
 */

export type PublishRefs = {
  issueNumber?: number
  pullNumber?: number
  branch?: string
  url?: string
  checkRunId?: number
  commentId?: number
}

export type PublishExecuteInput = {
  operation: PublishOperation
  repository: string
  candidateSha?: string
  branch?: string
  baseBranch?: string
  directory?: string
  title?: string
  body?: string
  pullNumber?: number
  marker?: string
  deliveryCheckEnabled?: boolean
}

export type PublishExecuteResult = { refs: PublishRefs }

export type PublishFacts = {
  issue?: { number: number; title: string; state: string; markerPresent: boolean; authorIsApp: boolean }
  pull?: {
    number: number
    title: string
    headSha: string
    draft?: boolean
    headBranch: string
    baseRef: string
    state: string
    markerPresent: boolean
    authorIsApp: boolean
  }
  delivery?: { checkRunId: number; headSha: string }
  ci: { state: "success" | "failure" | "pending" | "none" }
}

export type PublishTransport = {
  execute(input: PublishExecuteInput, signal?: AbortSignal): Promise<PublishExecuteResult>
  observe(
    input: { repository: string; issueNumber?: number; pullNumber?: number; ref?: string; marker?: string },
    signal?: AbortSignal,
  ): Promise<PublishFacts>
}

/**
 * Public branch token: derived from a hash of the case id, never the raw
 * internal id, so the remote branch carries no private identifier.
 */
export function publicCaseToken(caseId: string): string {
  return externalIdentityHash(caseId).slice(0, 12)
}

/** Hidden HTML marker embedded in issue/PR bodies for reconciliation. */
export function caseMarker(caseId: string): string {
  return `<!-- oryn:${publicCaseToken(caseId)} -->`
}

export function orynBranch(caseId: string): string {
  return `codex/oryn/${publicCaseToken(caseId)}`
}

let transport: PublishTransport | undefined

/** Product assembly injection; the provider supplies the real implementation. */
export function setTransport(fn: PublishTransport): void {
  transport = fn
}

function requireTransport(): PublishTransport {
  if (!transport) throw storeError("ENVIRONMENT_UNAVAILABLE", "no publish transport is configured")
  return transport
}

const CANDIDATE_OPERATIONS: PublishOperation[] = ["ensure_draft", "refresh_pr", "publish_review", "mark_ready"]

async function actionTolerantPause(caseId: string, expectedRevision: number): Promise<void> {
  await OrynStore.control(caseId, expectedRevision, "pause").catch(() => undefined)
}
function sameReadyConfig(
  target: NonNullable<ActionReceipt["readyTarget"]>,
  repo: {
    owner: string
    repo: string
    baseBranch?: string
    deliveryCheck?: boolean
  },
): boolean {
  return (
    target.repository === `${repo.owner}/${repo.repo}` &&
    target.baseBranch === (repo.baseBranch ?? "dev") &&
    target.deliveryCheck === (repo.deliveryCheck === true)
  )
}

async function completeReady(action: ActionReceipt): Promise<void> {
  if (action.operation !== "mark_ready" || action.state !== "acknowledged" || !action.remoteRefs?.pullNumber) return
  if (!action.readyTarget) return
  const record = await OrynStore.getCase(action.caseId)
  if (!record || record.control !== "active" || record.epoch !== action.epoch || !record.activeAttemptId) return
  const attempt = await OrynStore.getAttempt(record.id, record.activeAttemptId)
  if (!attempt || attempt.id !== action.readyTarget.attemptId || attempt.candidateSha !== action.expectedHead) return
  const config = await OrynConfig.info()
  const repo = config?.repositories?.[record.repoAlias]
  if (!config?.enabled || !repo || !sameReadyConfig(action.readyTarget, repo)) return
  if (attempt.disposition !== "ready") {
    await OrynStore.mutateAttempt(record.id, attempt.id, (draft) => ({ ...draft, disposition: "ready" as const }))
  }
  for (const sourceKeyHash of record.sourceIds) {
    await OrynStore.writeOutbox({
      caseId: record.id,
      sourceKeyHash,
      kind: "ready",
      text: `Fix is ready for human review (PR #${action.remoteRefs.pullNumber}, candidate ${action.expectedHead})`,
      dedupKey: `${record.id}:ready:${attempt.id}`,
    })
  }
  await OrynLearning.promoteCase(record.id).catch(() => undefined)
}

export namespace OrynPublish {
  /**
   * Execute one host-verified publish operation through the injected
   * transport. Preconditions: engineering root session, active case, current
   * epoch, configured repository, operation allowlist, frozen candidate for
   * candidate-bearing operations, and (for mark_ready) a fully green
   * delivery gate.
   */
  export async function publish(
    input: {
      callerSessionID: string
      caseId: string
      operation: PublishOperation
      requestKey: string
      title?: string
      body?: string
      pullNumber?: number
      payload?: string
      attemptId?: string
    },
    signal?: AbortSignal,
  ): Promise<{
    actionId?: string
    state: ActionReceipt["state"]
    refs?: PublishRefs
    deduped: boolean
  }> {
    if (input.operation === "sync_labels") throw storeError("NOT_AUTHORIZED", "label synchronization is host-owned")
    if (!(await OrynConfig.enabled())) throw storeError("NOT_AUTHORIZED", "oryn runtime is disabled")
    const binding = await OrynStore.sessionSourceBinding(input.callerSessionID)
    if (!binding || binding.role !== "engineering") {
      throw storeError("NOT_AUTHORIZED", "only the case engineering session may publish")
    }
    const record = await OrynStore.getCase(input.caseId)
    if (!record) throw storeError("NOT_AUTHORIZED", `case ${input.caseId} not found`)
    if (record.engineeringSessionId !== input.callerSessionID) {
      throw storeError("NOT_AUTHORIZED", "caller is not the case engineering root")
    }
    if (record.control !== "active") {
      throw storeError("HUMAN_OWNED", `case is ${record.control}`, { caseId: input.caseId })
    }
    const oryn = await OrynConfig.info()
    const repoCfg = oryn?.repositories?.[record.repoAlias]
    if (!repoCfg) {
      throw storeError("NOT_AUTHORIZED", `repository alias ${record.repoAlias} is not configured`)
    }
    const allowed = repoCfg.allowedOperations
    if (allowed && input.operation !== "notify_feishu" && !allowed.includes(input.operation)) {
      throw storeError("NOT_AUTHORIZED", `operation ${input.operation} is not allowed for this repository`)
    }
    const repository = `${repoCfg.owner}/${repoCfg.repo}`
    const marker = caseMarker(input.caseId)

    const attemptId = input.attemptId ?? record.activeAttemptId
    const attempt = attemptId ? await OrynStore.getAttempt(input.caseId, attemptId) : undefined
    let candidateSha: string | undefined
    if (CANDIDATE_OPERATIONS.includes(input.operation)) {
      if (!attempt?.candidateSha) {
        throw storeError("INVALID_STAGE", `${input.operation} requires a frozen candidate`, { caseId: input.caseId })
      }
      if (attempt.id !== record.activeAttemptId)
        throw storeError("INVALID_STAGE", "publication requires the active attempt")
      candidateSha = attempt.candidateSha
    }
    const existing = await OrynStore.findActionByRequestKey(input.caseId, input.requestKey)
    if (existing) {
      if (existing.operation !== input.operation)
        throw storeError("INVALID_STAGE", "requestKey belongs to a different publication operation")
      if (existing.epoch !== record.epoch) {
        return { actionId: existing.id, state: "cancelled", refs: existing.remoteRefs, deduped: true }
      }
      if (existing.state === "rejected" || existing.state === "cancelled") {
        throw storeError("INVALID_STAGE", "requestKey already failed; use a new requestKey", { caseId: input.caseId })
      }
      // Idempotent replay: return the settled receipt without re-running the
      // delivery gate (which would now fail on the rotated disposition).
      await completeReady(existing)
      return { actionId: existing.id, state: existing.state, refs: existing.remoteRefs, deduped: true }
    }

    const targetsPull = ["refresh_pr", "publish_review", "mark_ready"].includes(input.operation)
    const pullNumber = targetsPull ? (input.pullNumber ?? record.pullNumbers.at(-1)) : undefined
    if (targetsPull && (!pullNumber || !record.pullNumbers.includes(pullNumber))) {
      throw storeError("NOT_AUTHORIZED", "publication requires a pull request bound to this Case")
    }

    // Case-level artifact idempotency: one oryn issue / one candidate PR per
    // case, verified against remote facts before anything new is created.
    if (input.operation === "ensure_issue" && record.issueNumber) {
      const facts = await requireTransport().observe({
        repository,
        issueNumber: record.issueNumber,
        marker,
      })
      if (!facts.issue) {
        throw storeError("REMOTE_AMBIGUOUS", "linked issue is missing remotely; refusing to create a duplicate")
      }
      if (!facts.issue.markerPresent || !facts.issue.authorIsApp) {
        throw storeError("REMOTE_AMBIGUOUS", "linked issue lacks the Oryn marker; refusing to create a duplicate")
      }
      const receipt = await OrynStore.writeAction({
        caseId: input.caseId,
        operation: input.operation,
        payloadDigest: externalIdentityHash(input.operation, input.title ?? "", input.body ?? ""),
        expectedRevision: record.revision,
        epoch: record.epoch,
        requestKey: input.requestKey,
        state: "acknowledged",
        remoteRefs: { issueNumber: facts.issue.number },
      })
      return { actionId: receipt.id, state: "acknowledged", refs: receipt.remoteRefs, deduped: true }
    }
    if (input.operation === "ensure_draft" && record.pullNumbers.length > 0) {
      const pullNumber = record.pullNumbers[record.pullNumbers.length - 1]!
      const facts = await requireTransport().observe({
        repository,
        pullNumber,
        marker,
        ref: candidateSha,
      })
      if (!facts.pull) {
        throw storeError("REMOTE_AMBIGUOUS", "recorded pull request is missing remotely")
      }
      if (facts.pull.headSha !== candidateSha) {
        throw storeError("INVALID_STAGE", "candidate advanced past the published PR; use refresh_pr", {
          caseId: input.caseId,
        })
      }
      const receipt = await OrynStore.writeAction({
        caseId: input.caseId,
        operation: input.operation,
        payloadDigest: externalIdentityHash(input.operation, input.title ?? "", input.body ?? "", candidateSha ?? ""),
        expectedHead: candidateSha,
        expectedRevision: record.revision,
        epoch: record.epoch,
        requestKey: input.requestKey,
        state: "acknowledged",
        remoteRefs: { pullNumber: facts.pull.number, branch: facts.pull.headBranch },
      })
      return { actionId: receipt.id, state: "acknowledged", refs: receipt.remoteRefs, deduped: true }
    }
    if (input.operation === "refresh_pr" && record.pullNumbers.length === 0 && !input.pullNumber) {
      throw storeError("INVALID_STAGE", "no pull request to refresh; use ensure_draft", { caseId: input.caseId })
    }
    if (input.operation === "publish_review" && !input.pullNumber && record.pullNumbers.length === 0) {
      throw storeError("INVALID_STAGE", "publish_review requires a published pull request", { caseId: input.caseId })
    }

    const publication =
      input.operation === "ensure_issue"
        ? OrynPublication.issue({ record, title: input.title, notes: input.body })
        : CANDIDATE_OPERATIONS.includes(input.operation) && attempt
          ? await OrynPublication.capture({ repository, record, attempt, title: input.title, notes: input.body })
          : undefined
    const directory =
      publication && "directory" in publication && typeof publication.directory === "string"
        ? publication.directory
        : undefined
    const title = publication?.title ?? input.title
    const body = `${publication?.body ?? input.body ?? ""}\n\n${marker}`
    if (input.operation === "mark_ready") {
      if (!candidateSha)
        throw storeError("INVALID_STAGE", "mark_ready requires a frozen candidate", { caseId: input.caseId })
      const facts = await requireTransport().observe({ repository, pullNumber, ref: candidateSha, marker }, signal)
      if (
        !facts.pull ||
        facts.pull.number !== pullNumber ||
        facts.pull.state !== "open" ||
        typeof facts.pull.draft !== "boolean" ||
        facts.pull.headSha !== candidateSha ||
        facts.pull.headBranch !== orynBranch(input.caseId) ||
        facts.pull.baseRef !== (repoCfg.baseBranch ?? "dev") ||
        !facts.pull.markerPresent ||
        !facts.pull.authorIsApp
      ) {
        throw storeError("REMOTE_AMBIGUOUS", "published pull request no longer matches the authorized candidate")
      }
      const ciStatus =
        facts.ci.state === "success"
          ? ("passed" as const)
          : facts.ci.state === "failure"
            ? ("failed" as const)
            : undefined
      const gate = await OrynService.evaluateDelivery({
        callerSessionID: input.callerSessionID,
        caseId: input.caseId,
        payload: body,
        ciStatus,
      })
      if (!gate.ready) {
        const detail = gate.failures.map((f) => `${f.code}: ${f.message}`).join("; ")
        throw storeError("EVIDENCE_INSUFFICIENT", `delivery gate not satisfied — ${detail}`, {
          caseId: input.caseId,
        })
      }
    }

    const receipt = await OrynStore.writeAction({
      caseId: input.caseId,
      operation: input.operation,
      payloadDigest: externalIdentityHash(input.operation, title ?? "", body, candidateSha ?? ""),
      expectedHead: candidateSha,
      ...(input.operation === "mark_ready"
        ? {
            readyTarget: {
              attemptId: attemptId!,
              repository,
              branch: orynBranch(input.caseId),
              baseBranch: repoCfg.baseBranch ?? "dev",
              deliveryCheck: repoCfg.deliveryCheck === true,
            },
          }
        : {}),
      expectedRevision: record.revision,
      epoch: record.epoch,
      requestKey: input.requestKey,
      state: "prepared",
      remoteRefs: pullNumber ? { pullNumber } : undefined,
    })

    // Re-check state immediately before flight so a takeover or cancel that
    // raced the preparation invalidates the action instead of publishing.
    const fresh = await OrynStore.getCase(input.caseId)
    if (
      !fresh ||
      fresh.epoch !== record.epoch ||
      fresh.control !== "active" ||
      (CANDIDATE_OPERATIONS.includes(input.operation) && fresh.activeAttemptId !== attemptId)
    ) {
      await OrynStore.mutateAction(receipt.id, (a) => ({ ...a, state: "cancelled" }))
      throw storeError("HUMAN_OWNED", "case state changed; action cancelled", { caseId: input.caseId })
    }

    await OrynStore.mutateAction(receipt.id, (a) => ({ ...a, state: "in_flight" }))
    try {
      const result = await requireTransport().execute(
        {
          operation: input.operation,
          repository,
          candidateSha,
          branch: orynBranch(input.caseId),
          baseBranch: repoCfg.baseBranch ?? "dev",
          directory,
          title,
          body,
          pullNumber,
          marker,
          deliveryCheckEnabled: repoCfg.deliveryCheck === true,
        },
        signal,
      )
      const refs = result.refs
      const settled = await OrynStore.mutateAction(receipt.id, (a) => ({
        ...a,
        state: "acknowledged",
        remoteRefs: { ...(a.remoteRefs ?? {}), ...refs },
      }))
      await OrynStore.attachRemoteRefs(input.caseId, {
        issueNumber: refs.issueNumber,
        pullNumber: refs.pullNumber,
      })
      await completeReady(settled)
      return { actionId: settled.id, state: settled.state, refs: settled.remoteRefs, deduped: false }
    } catch (error) {
      const name = error instanceof Error ? error.name : ""
      const aborted = signal?.aborted === true
      const transient =
        input.operation === "mark_ready" ||
        aborted ||
        name === "GitHubApiError" ||
        name === "AbortError" ||
        name === "TimeoutError"
      if (name === "PublishNonFastForwardError") {
        // Deterministic divergence: the branch moved without Oryn. Never
        // force; park the receipt as rejected and fail the action.
        await OrynStore.mutateAction(receipt.id, (a) => ({
          ...a,
          state: "rejected",
          lastErrorClass: "NON_FAST_FORWARD",
        }))
        throw storeError("REMOTE_AMBIGUOUS", "remote branch diverged; human reconciliation required", {
          caseId: input.caseId,
        })
      }
      await OrynStore.mutateAction(receipt.id, (a) => ({
        ...a,
        state: transient ? "ambiguous" : "rejected",
        lastErrorClass: aborted ? "ABORTED" : transient ? "REMOTE_ERROR" : "REMOTE_REJECTED",
      }))
      if (transient) {
        throw storeError("REMOTE_AMBIGUOUS", "action outcome unknown; reconciliation will verify", {
          caseId: input.caseId,
        })
      }
      throw error
    }
  }

  /**
   * Bounded reconciliation for one ambiguous action: re-query remote facts
   * up to `maxAttempts` times and settle only on unambiguous evidence
   * (author is the App, marker present, head matches the expected SHA for
   * push operations). Uncertainty after the bound pauses the case
   * (fail-closed) and leaves the receipt ambiguous — no blind replay.
   */
  export async function reconcileAmbiguous(caseId: string, actionId: string, maxAttempts = 3): Promise<ActionReceipt> {
    const action = await OrynStore.getAction(actionId)
    if (!action) throw storeError("NOT_AUTHORIZED", `action ${actionId} not found`)
    if (action.caseId !== caseId) throw storeError("NOT_AUTHORIZED", "action belongs to another Case")
    if (action.operation === "sync_labels") return action
    if (action.state !== "ambiguous") {
      await completeReady(action)
      return action
    }
    const record = await OrynStore.getCase(caseId)
    if (!record) throw storeError("NOT_AUTHORIZED", `case ${caseId} not found`)
    if (record.epoch !== action.epoch) {
      return OrynStore.mutateAction(actionId, (a) => ({ ...a, state: "cancelled" }))
    }
    const oryn = await OrynConfig.info()
    const repoCfg = oryn?.repositories?.[record.repoAlias]
    if (!repoCfg) return action
    const repository = `${repoCfg.owner}/${repoCfg.repo}`
    const marker = caseMarker(caseId)

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const facts = await requireTransport().observe({
        repository,
        issueNumber: action.remoteRefs?.issueNumber,
        pullNumber: action.remoteRefs?.pullNumber,
        ref: action.expectedHead,
        marker,
      })
      if (action.operation === "ensure_issue") {
        if (facts.issue?.markerPresent && facts.issue.authorIsApp) {
          return OrynStore.mutateAction(actionId, (a) => ({
            ...a,
            state: "acknowledged",
            remoteRefs: { ...(a.remoteRefs ?? {}), issueNumber: facts.issue!.number },
          }))
        }
      } else if (action.operation === "ensure_draft" || action.operation === "refresh_pr") {
        if (facts.pull) {
          if (facts.pull.headSha === action.expectedHead && facts.pull.markerPresent && facts.pull.authorIsApp) {
            return OrynStore.mutateAction(actionId, (a) => ({
              ...a,
              state: "acknowledged",
              remoteRefs: {
                ...(a.remoteRefs ?? {}),
                pullNumber: facts.pull!.number,
                branch: facts.pull!.headBranch,
              },
            }))
          }
          if (facts.pull.headSha !== action.expectedHead && facts.pull.authorIsApp && facts.pull.markerPresent) {
            // A human moved the branch: the remote is no longer ours. Cancel
            // the action AND freeze the case so automation cannot race the
            // human's push with another one (fail-closed takeover).
            const cancelled = await OrynStore.mutateAction(actionId, (a) => ({ ...a, state: "cancelled" }))
            const fresh = await OrynStore.getCase(caseId)
            if (fresh && fresh.control === "active") {
              await actionTolerantPause(caseId, fresh.revision)
            }
            return cancelled
          }
        }
      } else if (action.operation === "mark_ready") {
        const target = action.readyTarget
        if (!target || !sameReadyConfig(target, repoCfg) || target.attemptId !== record.activeAttemptId) break
        const pull = facts.pull
        if (
          pull &&
          pull.number === action.remoteRefs?.pullNumber &&
          record.pullNumbers.includes(pull.number) &&
          pull.state === "open" &&
          pull.draft === false &&
          pull.headSha === action.expectedHead &&
          pull.headBranch === orynBranch(caseId) &&
          pull.baseRef === (repoCfg.baseBranch ?? "dev") &&
          pull.markerPresent &&
          pull.authorIsApp &&
          (!target.deliveryCheck || facts.delivery?.headSha === action.expectedHead)
        ) {
          const active = record.activeAttemptId ? await OrynStore.getAttempt(caseId, record.activeAttemptId) : undefined
          if (!active || active.candidateSha !== action.expectedHead || record.control !== "active") break
          const gate =
            active.disposition === "ready"
              ? { ready: true }
              : await OrynService.evaluateDelivery({
                  callerSessionID: record.engineeringSessionId!,
                  caseId,
                  payload: `Verified candidate ${action.expectedHead}`,
                  ciStatus:
                    facts.ci.state === "success" ? "passed" : facts.ci.state === "failure" ? "failed" : undefined,
                })
          if (!gate.ready) break
          const settled = await OrynStore.mutateAction(actionId, (value) => ({
            ...value,
            state: "acknowledged",
            remoteRefs: {
              ...value.remoteRefs,
              pullNumber: pull.number,
              ...(facts.delivery ? { checkRunId: facts.delivery.checkRunId } : {}),
            },
          }))
          await completeReady(settled)
          return settled
        }
      } else {
        break
      }
    }
    const fresh = await OrynStore.getCase(caseId)
    if (fresh && fresh.control === "active") {
      await actionTolerantPause(caseId, fresh.revision)
    }
    return (await OrynStore.getAction(actionId))!
  }

  /** Reconcile every ambiguous action; the poll loop calls this incrementally. */
  export async function reconcileAllAmbiguous(): Promise<number> {
    if (!(await OrynConfig.enabled())) return 0
    const actions = await OrynStore.listActions()
    let settled = 0
    for (const action of actions) {
      if (action.state === "acknowledged" && action.operation === "mark_ready") {
        await completeReady(action).catch(() => undefined)
        continue
      }
      if (action.operation === "sync_labels") continue
      if (action.state !== "ambiguous") continue
      const before = action.state
      const after = await reconcileAmbiguous(action.caseId, action.id).catch(() => undefined)
      if (after && before === "ambiguous" && after.state !== "ambiguous") settled++
    }
    return settled
  }

  /** Remote facts for a case (CI state, marker presence, head SHA). */
  export async function observeCase(
    input: { caseId: string; ref?: string },
    signal?: AbortSignal,
  ): Promise<PublishFacts> {
    const record = await OrynStore.getCase(input.caseId)
    if (!record) throw storeError("NOT_AUTHORIZED", `case ${input.caseId} not found`)
    const oryn = await OrynConfig.info()
    const repoCfg = oryn?.repositories?.[record.repoAlias]
    if (!repoCfg) throw storeError("NOT_AUTHORIZED", `repository alias ${record.repoAlias} is not configured`)
    return requireTransport().observe(
      {
        repository: `${repoCfg.owner}/${repoCfg.repo}`,
        issueNumber: record.issueNumber,
        pullNumber: record.pullNumbers[record.pullNumbers.length - 1],
        ref:
          input.ref ??
          (record.activeAttemptId
            ? (await OrynStore.getAttempt(input.caseId, record.activeAttemptId))?.candidateSha
            : undefined),
        marker: caseMarker(input.caseId),
      },
      signal,
    )
  }

  /**
   * Authorized bounded remote-fact read for oryn_github_read: any Oryn role
   * may read, but QA sessions must be linked to the case through their
   * source while engineering/worker sessions must be bound to the case.
   */
  export async function readFacts(input: {
    callerSessionID: string
    caseId: string
    ref?: string
  }): Promise<PublishFacts> {
    if (!(await OrynConfig.enabled())) throw storeError("NOT_AUTHORIZED", "oryn runtime is disabled")
    const binding = await OrynStore.sessionSourceBinding(input.callerSessionID)
    if (!binding) throw storeError("NOT_AUTHORIZED", "session has no Oryn source binding")
    if (binding.role === "qa") {
      const link = await OrynStore.getSource(binding.sourceKey)
      if (!link || !link.caseIds.includes(input.caseId)) {
        throw storeError("NOT_AUTHORIZED", `source is not linked to case ${input.caseId}`)
      }
    } else if (binding.caseId !== input.caseId) {
      throw storeError("NOT_AUTHORIZED", "case does not belong to this session")
    }
    return observeCase({ caseId: input.caseId, ref: input.ref })
  }
}
