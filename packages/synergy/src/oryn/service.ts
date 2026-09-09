import { MessageV2 } from "../session/message-v2"
import { OrynGithub } from "./github"
import { OrynDiscovery } from "./discovery"
import { OrynNotifications } from "./notifications"
import { OrynGithubStore } from "./github-store"
import { OrynPublicText } from "./public-text"
import { Log } from "../util/log"
import { Lock } from "../util/lock"
import { externalIdentityHash } from "../util/identity"
import { Identifier } from "../id/id"
import { ScopeContext } from "../scope/context"
import { Session } from "../session"
import { BossService } from "../boss/boss"
import { OrynStore, sourceKey, storeError } from "./store"
import { OrynCandidate } from "./candidate"
import { OrynControl } from "./control"
import { OrynOwnership } from "./ownership"
import { OrynResume } from "./resume"
import { OrynConfig } from "./config"
import { OrynEngineering } from "./engineering"
import { OrynReports } from "./reports"
import { OrynReady } from "./ready"
import { OrynReviewPolicy } from "./review-policy"
import { OrynBudget } from "./budget"
import { OrynEvidence } from "./evidence"
import { Finding as FindingSchema, REVIEW_POLICY_VERSION } from "./schema"
import type { Case, Finding, OutboxEntry, ReviewDomain, RunReceipt, SourceIdentity, Stage } from "./schema"
import { OrynExecutor } from "./executor"

/**
 * Stage → agent mapping is Host-owned: models request a stage, never an
 * agent. Verification reuses the repro agent definition in a brand-new
 * session (fresh context for the frozen candidate), per the proposal.
 */
const STAGE_AGENT: Record<Stage, string> = {
  repro: "oryn-repro",
  code: "oryn-code",
  verify: "oryn-repro",
  review: "oryn-review",
}

type Role = "qa" | "engineering" | "worker"

async function requireEnabled(): Promise<void> {
  if (!(await OrynConfig.enabled())) throw storeError("NOT_AUTHORIZED", "oryn runtime is disabled")
}

async function requireBinding(sessionID: string, roles: Role[]): Promise<OrynStore.SessionSourceBinding> {
  const binding = await OrynStore.sessionSourceBinding(sessionID)
  if (!binding) throw storeError("NOT_AUTHORIZED", "session has no Oryn source binding")
  if (!roles.includes(binding.role as Role)) {
    throw storeError("NOT_AUTHORIZED", `session role "${binding.role}" is not allowed for this operation`)
  }
  return binding
}

function feishuIdentity(binding: OrynStore.SessionSourceBinding): SourceIdentity & { chatId: string } {
  const identity = binding.identity
  if (!identity || identity.provider !== "feishu" || !identity.chatId) {
    throw storeError("NOT_AUTHORIZED", "session is not bound to a Feishu source")
  }
  return identity as SourceIdentity & { chatId: string }
}

async function requireActiveCase(caseId: string) {
  const record = await OrynStore.getCase(caseId)
  if (!record) throw storeError("NOT_AUTHORIZED", `case ${caseId} not found`)
  if (record.control === "human_owned" || record.control === "cancelled" || record.control === "closed") {
    throw storeError("HUMAN_OWNED", `case is ${record.control}`, { caseId })
  }
  if (record.control === "paused") throw storeError("HUMAN_OWNED", "case is paused", { caseId })
  await OrynBudget.assert(record)
  return record
}
async function assertStageAdmission(caseId: string, attemptId: string, stage: Stage): Promise<void> {
  const [record, attempt, assignments, reports] = await Promise.all([
    OrynStore.getCase(caseId),
    OrynStore.getAttempt(caseId, attemptId),
    OrynStore.listAssignments(caseId),
    OrynStore.listWorkerReports(caseId),
  ])
  if (!record || !attempt) throw storeError("INVALID_STAGE", "stage requires an existing case and Attempt")
  const github = await OrynGithubStore.get(caseId)
  if (github?.mode === "review") {
    if (
      stage !== "review" ||
      github.state !== "running" ||
      github.attemptFingerprint !== github.fingerprint ||
      github.snapshot.state !== "open" ||
      github.snapshot.draft ||
      attempt.candidateSha !== github.snapshot.headSha ||
      attempt.baselineSha !== github.snapshot.mergeBaseSha
    )
      throw storeError("INVALID_STAGE", "External PR work only admits review of the assigned head and merge base")
    return
  }
  if (stage === "code" && github) {
    if (!(await OrynGithub.authorized(github, "code")))
      throw storeError("NOT_AUTHORIZED", "Automatic fixes require operator opt-in")
  }
  if (stage === "code") {
    const discovery = await OrynDiscovery.lineage(caseId)
    const rootGithub = discovery ? await OrynGithubStore.get(discovery.rootCaseId) : undefined
    if (rootGithub && !(await OrynGithub.authorized(rootGithub, "code")))
      throw storeError("NOT_AUTHORIZED", "Root case repair authority was revoked")
  }
  const accepted = reports.filter((report) =>
    assignments.some(
      (assignment) =>
        assignment.id === report.assignmentId &&
        assignment.acceptedReportId === report.id &&
        assignment.attemptId === report.attemptId &&
        assignment.epoch === record.epoch &&
        report.epoch === record.epoch &&
        assignment.stage ===
          { repro: "repro", candidate: "code", verification: "verify", review_note: "review" }[report.kind],
    ),
  )
  if (stage === "code") {
    for (const report of accepted.filter((report) => report.kind === "repro" && report.outcome === "reproduced")) {
      const sourceAttempt = await OrynStore.getAttempt(caseId, report.attemptId)
      if (!sourceAttempt) continue
      const assignment = assignments.find((item) => item.id === report.assignmentId)!
      if (
        await OrynEvidence.reportRuns({ assignment, attempt: sourceAttempt, report }).then(
          () => true,
          () => false,
        )
      )
        return
    }
    throw storeError("INVALID_STAGE", "code requires an accepted reproduction with valid run evidence", { caseId })
  }
  if (stage === "verify" || stage === "review") {
    const candidate = accepted.find(
      (report) =>
        report.kind === "candidate" && report.attemptId === attemptId && report.candidateSha === attempt.candidateSha,
    )
    if (!candidate || !attempt.candidateSha || attempt.disposition !== "candidate_frozen")
      throw storeError("INVALID_STAGE", `${stage} requires an accepted frozen candidate on this attempt`, { caseId })
    const assignment = assignments.find((item) => item.id === candidate.assignmentId)!
    await OrynCandidate.verify({
      assignment,
      attempt,
      candidateSha: candidate.candidateSha,
      localBranch: candidate.localBranch,
    })
  }
}

function taskText(input: {
  caseId: string
  attemptId: string
  assignmentId: string
  stage: Stage
  baselineSha: string
  candidateSha?: string
  reviewDomain?: ReviewDomain
  summary: string
  observed?: string
  expected?: string
}): string {
  const lines = [
    `Oryn assignment ${input.assignmentId} (stage: ${input.stage})`,
    `Case: ${input.caseId}`,
    `Attempt: ${input.attemptId}`,
    `Baseline: ${input.baselineSha}`,
    input.candidateSha ? `Candidate: ${input.candidateSha}` : undefined,
    input.stage === "review" ? `Review domain: ${input.reviewDomain ?? "general"}` : undefined,
    input.stage === "review" ? `Review policy: ${REVIEW_POLICY_VERSION}` : undefined,
    `Summary: ${input.summary}`,
    input.observed ? `Observed: ${input.observed}` : undefined,
    input.expected ? `Expected: ${input.expected}` : undefined,
    "",
    "Complete the assignment inside your assigned scope. Submit the structured outcome with oryn_result submit (caseId, attemptId, assignmentId above). Cite run receipts for any claim about tests. If you cannot proceed, submit a result with the specific blocker instead of guessing.",
  ]
  return lines.filter((line) => line !== undefined).join("\n")
}

export namespace OrynService {
  export function handoffSummary(record: Case) {
    if (record.control !== "human_owned" || !record.handoff) return undefined
    return {
      ...record.handoff,
      reason: OrynPublicText.violations(record.handoff.reason).length
        ? "More information is required; inspect the engineering task in the operator workspace."
        : record.handoff.reason,
    }
  }

  function handoffKey(record: Case) {
    return externalIdentityHash(record.id, "needs_human", String(record.handoff?.epoch))
  }

  async function handoffGroup(record: Case, key: string) {
    const source = await OrynStore.getSource(key)
    if (
      !source ||
      !(await OrynNotifications.operator(source.identity)) ||
      !/budget|environment|dependenc|failed to start|failed to reconcile|execution was interrupted/i.test(
        record.handoff?.reason ?? "",
      )
    )
      return [record]
    const group: Case[] = []
    for (const item of await OrynStore.listCases({ control: "human_owned" })) {
      if (
        item.repoAlias !== record.repoAlias ||
        item.handoff?.reason !== record.handoff?.reason ||
        item.handoff?.epoch !== item.epoch
      )
        continue
      if ((await OrynStore.getSource(item.sourceIds[0]!))?.identity.provider !== "github") continue
      group.push(item)
    }
    return group.sort((a, b) => a.id.localeCompare(b.id))
  }

  function groupKey(group: Case[]) {
    return group.length > 1
      ? `handoff-group:${externalIdentityHash(group[0]!.handoff!.reason, ...group.map(handoffKey))}`
      : handoffKey(group[0]!)
  }

  async function reporter(record: Case, key: string) {
    if (!record.sourceIds.includes(key)) return
    const source = await OrynStore.getSource(key)
    if (source?.caseIds.includes(record.id) && (await OrynNotifications.operator(source.identity))) return "operator"
    const channel = await OrynStore.channelSource(key)
    const config = await OrynConfig.info()
    if (
      !source?.caseIds.includes(record.id) ||
      source.identity.provider !== "feishu" ||
      !channel ||
      sourceKey(channel.identity) !== key ||
      !config?.enabled ||
      OrynConfig.resolveRepoAlias(config, source.identity) !== record.repoAlias
    )
      return
    const binding = await OrynStore.sessionSourceBinding(channel.qaSessionId)
    if (
      binding?.role !== "qa" ||
      binding.identity?.accountId !== channel.identity.accountId ||
      binding.identity.chatId !== channel.identity.chatId ||
      binding.identity.threadId !== channel.identity.threadId
    )
      return
    return channel.qaSessionId
  }

  export async function queueReadyNotifications(caseId: string) {
    const queued: Awaited<ReturnType<typeof OrynStore.writeOutbox>>[] = []
    await OrynNotifications.attach(caseId)
    const ready = await OrynReady.projection(caseId)
    if (!ready) return queued
    for (const key of ready.record.sourceIds) {
      if (!(await reporter(ready.record, key))) continue
      queued.push(
        await OrynStore.writeOutbox({
          caseId,
          sourceKeyHash: key,
          kind: "ready",
          text: ready.text,
          dedupKey: ready.dedupKey,
        }),
      )
    }
    return queued
  }

  async function queueHandoffNotifications(record: Case) {
    const queued: Awaited<ReturnType<typeof OrynStore.writeOutbox>>[] = []
    if (record.control !== "human_owned" || !record.handoff || record.handoff.epoch !== record.epoch) return queued
    const config = await OrynConfig.info()
    if (!config?.enabled) return queued
    await OrynNotifications.attach(record.id)
    record = (await OrynStore.getCase(record.id))!
    for (const key of record.sourceIds) {
      if (!(await reporter(record, key))) continue
      const reason = handoffSummary(record)!.reason
      const repository = config.repositories?.[record.repoAlias]
      const work = await OrynGithubStore.get(record.id)
      const number = record.pullNumbers.at(-1) ?? work?.number ?? record.issueNumber
      const target =
        repository && number
          ? `https://github.com/${repository.owner}/${repository.repo}/${record.pullNumbers.length || work?.mode === "review" ? "pull" : "issues"}/${number}`
          : undefined
      const summary = OrynPublicText.violations(record.summary).length ? "Repository task" : record.summary
      const operator = await OrynNotifications.operator((await OrynStore.getSource(key))!.identity)
      const group = await handoffGroup(record, key)
      await OrynNotifications.attach(group[0]!.id)
      const links: string[] = []
      for (const item of group.slice(0, 50)) {
        const binding = config.repositories?.[item.repoAlias]
        const github = await OrynGithubStore.get(item.id)
        const number = item.pullNumbers.at(-1) ?? github?.number ?? item.issueNumber
        if (binding && number)
          links.push(
            `https://github.com/${binding.owner}/${binding.repo}/${item.pullNumbers.length || github?.mode === "review" ? "pull" : "issues"}/${number}`,
          )
      }
      queued.push(
        await OrynStore.writeOutbox({
          caseId: group[0]?.id ?? record.id,
          sourceKeyHash: key,
          kind: "needs_human",
          text:
            group.length > 1
              ? `Oryn needs human input: ${reason}\nAffected tasks: ${group.length}\n${[...new Set(links)].join("\n")}`
              : `Oryn needs human input: ${reason}${operator ? `\n${summary}${target ? `\n${target}` : ""}` : ""}`,
          dedupKey: groupKey(group),
        }),
      )
    }
    return queued
  }

  export async function requestHandoff(input: { callerSessionID: string; caseId: string; reason: string }) {
    await requireEnabled()
    const binding = await requireBinding(input.callerSessionID, ["qa", "engineering"])
    const record = await OrynStore.getCaseForSession(input.caseId, input.callerSessionID)
    if (binding.role === "engineering" && record.engineeringSessionId !== input.callerSessionID) {
      throw storeError("NOT_AUTHORIZED", "caller is not the engineering root")
    }
    if (!input.reason.trim() || input.reason.length > 2000)
      throw storeError("INVALID_STAGE", "handoff requires a bounded reason")
    const handed = await OrynControl.handoff(input)
    await queueHandoffNotifications(handed)
    await drainOutbox()
    return handed
  }

  export async function recoverHandoffs() {
    const result = { recovered: 0, failed: 0 }
    if (!(await OrynConfig.enabled())) return result
    for (const record of await OrynStore.listCases({ control: "human_owned" })) {
      if (!record.handoff) continue
      try {
        await queueHandoffNotifications(record)
        result.recovered++
      } catch {
        result.failed++
      }
    }
    await drainOutbox()
    return result
  }

  /**
   * Host intake for a QA-submitted engineering case. Identity and routing
   * come from the Host-written session binding and config routes, never from
   * model input. Idempotent per requestKey; a new requestKey from the same
   * topic opens a new case.
   */
  export async function submitCase(input: {
    callerSessionID: string
    turnID?: string
    requestKey: string
    kind: "bug" | "feature" | "question" | "performance" | "usage"
    summary: string
    observed?: string
    expected?: string
  }): Promise<{
    caseId: string
    revision: number
    created: boolean
    repoAlias: string
    engineering: OrynEngineering.Result
  }> {
    await requireEnabled()
    const binding = await requireBinding(input.callerSessionID, ["qa"])
    const identity = feishuIdentity({
      ...binding,
      identity: await OrynStore.qaTurnSource(input.callerSessionID, input.turnID),
    })
    const oryn = await OrynConfig.info()
    const repoAlias = OrynConfig.resolveRepoAlias(oryn, { accountId: identity.accountId, chatId: identity.chatId })
    if (!repoAlias) {
      throw storeError("NOT_AUTHORIZED", "no repository route configured for this source; clarify with the reporter")
    }
    const { claim, created } = await OrynStore.claimSource({ identity, requestKey: input.requestKey })
    await OrynStore.recordSource({ identity })
    const record = await OrynStore.createCase({
      caseId: claim.caseId,
      kind: input.kind,
      summary: input.summary,
      observed: input.observed,
      expected: input.expected,
      repoAlias,
      sourceKeyHash: claim.sourceKey,
    })
    await OrynStore.linkSourceToCase(claim.sourceKey, record.id)
    await OrynStore.updateClaim(claim.sourceKey, input.requestKey, { state: "case_created" })
    const engineering = await OrynEngineering.start(record.id)
    if (engineering.state === "started")
      await OrynStore.updateClaim(claim.sourceKey, input.requestKey, { state: "completed" })
    return { caseId: record.id, revision: record.revision, created, repoAlias, engineering }
  }

  /**
   * Host entry for the engineering root: create (or reuse) the oryn-work
   * Boss session bound to the case and fix the initial attempt baseline.
   */
  export async function openEngineeringSession(input: {
    caseId: string
    identity: SourceIdentity
    baselineSha: string
    baseBranchSha?: string
  }): Promise<{ sessionID: string; attemptId: string }> {
    return OrynEngineering.open(input)
  }

  /**
   * Controlled dispatch. The caller must be the case's engineering root;
   * the Host picks the agent, fixes the frozen-input digest, dedups on
   * requestKey, and spawns the worker through BossService so the tree,
   * Inbox, and unattended interaction semantics stay with Boss.
   */
  export async function dispatch(input: {
    callerSessionID: string
    caseId: string
    attemptId?: string
    stage: Stage
    requestKey: string
    reviewDomain?: ReviewDomain
  }): Promise<{ assignmentId: string; workerSessionId: string; deduped: boolean }> {
    await requireEnabled()
    using _lock = await Lock.write(`oryn-case:${input.caseId}`)
    const binding = await requireBinding(input.callerSessionID, ["engineering"])
    if (binding.caseId !== input.caseId) {
      throw storeError("NOT_AUTHORIZED", "case does not belong to this engineering session")
    }
    const record = await requireActiveCase(input.caseId)
    if (record.engineeringSessionId !== input.callerSessionID) {
      throw storeError("NOT_AUTHORIZED", "caller is not the case engineering root")
    }
    const attemptId = input.attemptId ?? record.activeAttemptId
    if (attemptId !== record.activeAttemptId) throw storeError("INVALID_STAGE", "attempt is not active")
    if (!attemptId) throw storeError("INVALID_STAGE", "case has no active attempt", { caseId: input.caseId })
    const attempt = await OrynStore.getAttempt(input.caseId, attemptId)
    if (!attempt) throw storeError("NOT_AUTHORIZED", `attempt ${attemptId} not found`)
    if (
      attempt.disposition === "superseded" ||
      attempt.disposition === "failed" ||
      attempt.disposition === "ready" ||
      attempt.disposition === "handed_off"
    ) {
      throw storeError("INVALID_STAGE", `attempt is ${attempt.disposition}`, { caseId: input.caseId })
    }
    await assertStageAdmission(input.caseId, attemptId, input.stage)

    const existing = await OrynStore.findAssignmentByRequestKey(input.caseId, attemptId, input.requestKey)
    if (existing && existing.epoch !== record.epoch) {
      throw storeError("INVALID_STAGE", "assignment belongs to an invalidated epoch")
    }
    if (existing && (existing.stage !== input.stage || existing.reviewDomain !== input.reviewDomain)) {
      throw storeError("INVALID_STAGE", "dispatch request key belongs to a different assignment")
    }

    if (input.stage === "code") {
      const writers = (await OrynStore.listAssignments(input.caseId)).filter(
        (item) => item.attemptId === attemptId && item.stage === "code",
      )
      if (writers.some((item) => item.id !== existing?.id))
        throw storeError("INVALID_STAGE", "Attempt already has a code writer; replay its request or start rework")
    }

    const frozenInputsDigest = OrynEvidence.assignmentDigest(record, attempt, input.stage)
    if (existing && input.stage === "review" && existing.frozenInputsDigest !== frozenInputsDigest)
      throw storeError("INVALID_STAGE", "assignment inputs changed; request a new review with a fresh key")
    const assignment =
      existing ??
      (await OrynStore.createAssignment({
        caseId: input.caseId,
        attemptId,
        stage: input.stage,
        agentId: STAGE_AGENT[input.stage],
        frozenInputsDigest,
        epoch: record.epoch,
        reviewDomain: input.reviewDomain,
        requestKey: input.requestKey,
      }))

    await OrynStore.linkAssignment(assignment)
    const sessionId = assignment.sessionId ?? Identifier.descending("session")
    await OrynStore.setAssignmentSession(input.caseId, assignment.id, sessionId)
    const worker = await BossService.spawn(
      input.callerSessionID,
      {
        role: input.stage,
        agent: STAGE_AGENT[input.stage],
        instructions: `Oryn case ${input.caseId}: ${input.stage} assignment.`,
        workspace: "worktree",
        baseRevision:
          input.stage === "verify" || input.stage === "review" ? attempt.candidateSha! : attempt.baselineSha,
      },
      { sessionID: sessionId, requireExisting: Boolean(assignment.workspaceRef) },
    )
    if (worker.workspace?.type !== "git_worktree")
      throw storeError("ENVIRONMENT_UNAVAILABLE", "assignment requires its own version-pinned worktree")
    if (assignment.workspaceRef && assignment.workspaceRef !== worker.workspace.path)
      throw storeError("INVALID_STAGE", "assignment workspace reference changed")
    await OrynStore.setAssignmentWorkspace(input.caseId, assignment.id, worker.workspace.path)
    if (binding.identity) {
      await OrynStore.bindSessionSource({
        sessionID: worker.id,
        identity: binding.identity,
        caseId: input.caseId,
        role: "worker",
      })
    }

    await BossService.assign(
      input.callerSessionID,
      {
        sessionID: worker.id,
        taskID: assignment.id,
        task: taskText({
          caseId: input.caseId,
          attemptId,
          assignmentId: assignment.id,
          stage: input.stage,
          baselineSha: attempt.baselineSha,
          candidateSha: attempt.candidateSha,
          reviewDomain: assignment.reviewDomain,
          summary: record.summary,
          observed: record.observed,
          expected: record.expected,
        }),
      },
      { deliveryKey: `oryn:${assignment.id}` },
    )
    return { assignmentId: assignment.id, workerSessionId: worker.id, deduped: existing !== undefined }
  }

  export async function recoverWorkers(input?: { caseId?: string }) {
    const log = Log.create({ service: "oryn.workers" })
    const result = { recovered: 0, failed: 0 }
    const config = await OrynConfig.info()
    if (!config?.enabled) return result
    const records = input?.caseId
      ? [await OrynStore.getCase(input.caseId)]
      : await OrynStore.listCases({ control: "active" })
    for (const record of records) {
      if (!record || record.control !== "active") continue
      if (!record.engineeringSessionId || !config.repositories?.[record.repoAlias]) continue
      for (const assignment of await OrynStore.listAssignments(record.id)) {
        if (
          assignment.acceptedReportId ||
          assignment.attemptId !== record.activeAttemptId ||
          assignment.epoch !== record.epoch
        )
          continue
        try {
          const engineering = await OrynEngineering.start(record.id)
          if (engineering.state !== "started")
            throw storeError("NOT_AUTHORIZED", "engineering startup policy blocks worker recovery")
          const root = await Session.get(record.engineeringSessionId)
          if (root.time.archived) throw storeError("NOT_AUTHORIZED", "engineering root is archived")
          const dispatched = await ScopeContext.provide({
            scope: root.scope,
            workspace: root.workspace,
            fn: () =>
              dispatch({
                callerSessionID: root.id,
                caseId: record.id,
                attemptId: assignment.attemptId,
                stage: assignment.stage,
                requestKey: assignment.requestKey,
                reviewDomain: assignment.reviewDomain,
              }),
          })
          if ((await OrynResume.request(dispatched.workerSessionId)) === "exhausted") {
            await requestHandoff({
              callerSessionID: root.id,
              caseId: record.id,
              reason:
                "Worker execution was interrupted after three recovery attempts; inspect its preserved workspace and action receipts.",
            })
          }
          result.recovered++
        } catch (error) {
          result.failed++
          log.warn("worker recovery failed", { caseId: record.id, assignmentId: assignment.id, error })
        }
      }
    }
    return result
  }

  export async function recoverEngineeringTurns(input?: { caseId?: string }) {
    const result = { recovered: 0, failed: 0 }
    if (!(await OrynConfig.enabled())) return result
    const records = input?.caseId
      ? [await OrynStore.getCase(input.caseId)]
      : await OrynStore.listCases({ control: "active" })
    for (const record of records) {
      if (!record || record.control !== "active") continue
      try {
        const started = await OrynEngineering.start(record.id)
        if (started.state !== "started" || !started.sessionID) continue
        await OrynOwnership.prepare(record.id)
        const recovery = await OrynResume.request(started.sessionID)
        if (recovery === "exhausted")
          await requestHandoff({
            callerSessionID: started.sessionID,
            caseId: record.id,
            reason:
              "Engineering execution was interrupted after three recovery attempts; inspect the preserved action receipts before continuing.",
          })
        if (recovery === "recovered") result.recovered++
      } catch (error) {
        result.failed++
        Log.create({ service: "oryn.recovery" }).warn("engineering turn recovery failed", { caseId: record.id, error })
      }
    }
    return result
  }

  /**
   * Structured worker report intake. Identity comes from the Host binding
   * and the assignment's recorded session; epoch-stale reports are stored
   * for audit but never accepted onto the current candidate.
   */
  export async function submitResult(input: {
    callerSessionID: string
    caseId: string
    attemptId: string
    assignmentId: string
    requestKey: string
    kind: "repro" | "candidate" | "verification" | "review_note"
    outcome: string
    summary: string
    localBranch?: string
    candidateSha?: string
    runIds?: string[]
    addressedFindings?: string[]
    knownRisks?: string[]
    limitations?: string[]
  }): Promise<{ reportId: string; accepted: boolean; stale: boolean }> {
    await requireEnabled()
    using _lock = await Lock.write(`oryn-case:${input.caseId}`)
    const binding = await requireBinding(input.callerSessionID, ["worker"])
    if (binding.caseId !== input.caseId) throw storeError("NOT_AUTHORIZED", "case does not belong to this worker")
    const assignment = await OrynStore.getAssignment(input.caseId, input.assignmentId)
    if (!assignment) throw storeError("NOT_AUTHORIZED", `assignment ${input.assignmentId} not found`)
    if (assignment.sessionId !== input.callerSessionID) {
      throw storeError("NOT_AUTHORIZED", "assignment does not belong to this session")
    }
    if (assignment.attemptId !== input.attemptId) {
      throw storeError("INVALID_STAGE", "assignment belongs to a different attempt")
    }
    if (assignment.stage === "review")
      throw storeError("INVALID_STAGE", "review assignments require a structured review report")
    const expectedKind = { repro: "repro", code: "candidate", verify: "verification", review: "review_note" }[
      assignment.stage
    ]
    if (input.kind !== expectedKind) {
      throw storeError("INVALID_STAGE", "report kind does not match the assigned stage")
    }
    const record = await OrynStore.getCase(input.caseId)
    if (!record) throw storeError("NOT_AUTHORIZED", `case ${input.caseId} not found`)

    const report = await OrynStore.writeWorkerReport({
      caseId: input.caseId,
      attemptId: input.attemptId,
      assignmentId: input.assignmentId,
      requestKey: input.requestKey,
      epoch: assignment.epoch,
      kind: input.kind,
      outcome: input.outcome,
      summary: input.summary,
      localBranch: input.localBranch,
      candidateSha: input.candidateSha,
      runIds: input.runIds ?? [],
      addressedFindings: input.addressedFindings ?? [],
      knownRisks: input.knownRisks ?? [],
      limitations: input.limitations ?? [],
    })

    const attempt = await OrynStore.getAttempt(input.caseId, input.attemptId)
    if (
      record.epoch !== assignment.epoch ||
      record.control !== "active" ||
      record.activeAttemptId !== input.attemptId ||
      !attempt ||
      ["superseded", "failed", "handed_off", "ready"].includes(attempt.disposition)
    ) {
      return { reportId: report.id, accepted: false, stale: true }
    }

    await OrynEvidence.reportRuns({ assignment, attempt, report })

    if (input.kind === "candidate") {
      await OrynCandidate.verify({
        assignment,
        attempt,
        candidateSha: input.candidateSha,
        localBranch: input.localBranch,
      })
      if (assignment.acceptedReportId && assignment.acceptedReportId !== report.id)
        throw storeError("INVALID_STAGE", "assignment already accepted a different report")
      if (!attempt.candidateSha) {
        await OrynStore.mutateAttempt(input.caseId, input.attemptId, (draft) => ({
          ...draft,
          candidateSha: input.candidateSha!,
          disposition: "candidate_frozen",
        }))
      }
    }
    await OrynStore.acceptAssignmentReport(input.caseId, input.assignmentId, report.id)
    for (const runId of new Set(input.runIds ?? [])) {
      if (!attempt.evidenceRunIds.includes(runId))
        await OrynStore.attachRunEvidence(input.caseId, input.attemptId, runId)
    }
    await OrynReports.deliverAccepted(input.caseId, assignment.id)
    return { reportId: report.id, accepted: true, stale: false }
  }

  /**
   * Reviewer report intake. Only the review assignment's session may submit;
   * the host pins head to the frozen candidate and base to the attempt
   * baseline, enforces prior-finding continuity (an open finding cannot
   * silently disappear between reviews), and archives stale-epoch reports.
   */
  export async function submitReview(input: {
    callerSessionID: string
    caseId: string
    attemptId: string
    assignmentId: string
    requestKey: string
    headSha: string
    baseSha: string
    domain?: ReviewDomain
    findings: Finding[]
    questions?: string[]
    evidenceAssessment: string
    designDecisions?: string[]
    recommendation: "changes_required" | "needs_human" | "ready_for_human"
    limitedScope?: string
  }): Promise<{ reviewId: string; accepted: boolean; stale: boolean }> {
    await requireEnabled()
    using _lock = await Lock.write(`oryn-case:${input.caseId}`)
    const binding = await requireBinding(input.callerSessionID, ["worker"])
    if (binding.caseId !== input.caseId) throw storeError("NOT_AUTHORIZED", "case does not belong to this worker")
    const assignment = await OrynStore.getAssignment(input.caseId, input.assignmentId)
    if (!assignment) throw storeError("NOT_AUTHORIZED", `assignment ${input.assignmentId} not found`)
    if (assignment.sessionId !== input.callerSessionID) {
      throw storeError("NOT_AUTHORIZED", "assignment does not belong to this session")
    }
    if (assignment.stage !== "review") {
      throw storeError("INVALID_STAGE", "only review assignments submit review reports")
    }
    if (assignment.attemptId !== input.attemptId) {
      throw storeError("INVALID_STAGE", "assignment belongs to a different attempt")
    }
    const domain = assignment.reviewDomain ?? "general"
    if (input.domain && input.domain !== domain)
      throw storeError("INVALID_STAGE", "review domain does not match assignment")
    const attempt = await OrynStore.getAttempt(input.caseId, input.attemptId)
    if (!attempt) throw storeError("NOT_AUTHORIZED", `attempt ${input.attemptId} not found`)
    if (!attempt.candidateSha) {
      throw storeError("INVALID_STAGE", "review requires a frozen candidate", { caseId: input.caseId })
    }
    if (input.headSha !== attempt.candidateSha) {
      throw storeError("STALE_HEAD", "review head does not match the frozen candidate", { caseId: input.caseId })
    }
    if (input.baseSha !== attempt.baselineSha) {
      throw storeError("STALE_HEAD", "review base does not match the attempt baseline", { caseId: input.caseId })
    }
    const findings = FindingSchema.array().max(64).parse(input.findings)
    const assignments = await OrynStore.listAssignments(input.caseId)
    const accepted = new Set(assignments.map((item) => item.acceptedReportId))
    const prior = (await OrynStore.listReviews(input.caseId))
      .filter((r) => r.assignmentId !== input.assignmentId && r.domain === domain && accepted.has(r.id))
      .sort((a, b) => a.createdAt - b.createdAt)
    const latestPrior = prior.length > 0 ? prior[prior.length - 1] : undefined
    if (latestPrior) {
      for (const previousFinding of latestPrior.findings) {
        if (previousFinding.disposition !== "open" && previousFinding.disposition !== "still_open") continue
        const carried = findings.find((f) => f.id === previousFinding.id)
        if (!carried) {
          throw storeError(
            "EVIDENCE_INSUFFICIENT",
            `prior finding ${previousFinding.id} cannot silently disappear; dispose it explicitly`,
            { caseId: input.caseId },
          )
        }
      }
    }
    const record = await OrynStore.getCase(input.caseId)
    if (!record) throw storeError("NOT_AUTHORIZED", `case ${input.caseId} not found`)
    const report = await OrynStore.writeReview(
      {
        assignmentId: input.assignmentId,
        caseId: input.caseId,
        attemptId: input.attemptId,
        headSha: input.headSha,
        baseSha: input.baseSha,
        ...OrynEvidence.reviewDigests(record, attempt),
        domain,
        findings,
        questions: input.questions ?? [],
        evidenceAssessment: input.evidenceAssessment,
        designDecisions: input.designDecisions ?? [],
        recommendation: input.recommendation,
        ...(input.limitedScope ? { limitedScope: input.limitedScope } : {}),
      },
      input.requestKey,
    )
    if (
      record.epoch !== assignment.epoch ||
      record.control !== "active" ||
      record.activeAttemptId !== input.attemptId ||
      attempt.disposition !== "candidate_frozen" ||
      assignment.frozenInputsDigest !== OrynEvidence.assignmentDigest(record, attempt, "review")
    ) {
      return { reviewId: report.id, accepted: false, stale: true }
    }
    await OrynStore.acceptAssignmentReport(input.caseId, input.assignmentId, report.id)
    await OrynReports.deliverAccepted(input.caseId, assignment.id)
    return { reviewId: report.id, accepted: true, stale: false }
  }

  /**
   * Bounded rework: supersede the current attempt and open the next one on
   * the frozen candidate (append-only history), enforcing the configured
   * repair-round and no-progress caps. Hitting either cap hands the case to
   * a human deterministically instead of looping.
   */
  export async function rework(input: {
    callerSessionID: string
    caseId: string
    reason: string
  }): Promise<{ attemptId: string; repairRounds: number; noProgressRounds: number; handedOff: boolean }> {
    await requireEnabled()
    const binding = await requireBinding(input.callerSessionID, ["engineering"])
    if (binding.caseId !== input.caseId) {
      throw storeError("NOT_AUTHORIZED", "case does not belong to this engineering session")
    }
    const record = await requireActiveCase(input.caseId)
    if (record.engineeringSessionId !== input.callerSessionID) {
      throw storeError("NOT_AUTHORIZED", "caller is not the case engineering root")
    }
    const attemptId = record.activeAttemptId
    if (!attemptId) throw storeError("INVALID_STAGE", "case has no active attempt", { caseId: input.caseId })
    const attempt = await OrynStore.getAttempt(input.caseId, attemptId)
    if (!attempt?.candidateSha) {
      throw storeError("INVALID_STAGE", "rework requires a frozen candidate on the current attempt", {
        caseId: input.caseId,
      })
    }
    const oryn = await OrynConfig.info()
    const maxRepair = oryn?.review?.maxRepairRounds ?? 3
    const maxNoProgress = oryn?.review?.maxNoProgressRounds ?? 2
    const attempts = await OrynStore.listAttempts(input.caseId)
    const previous = attempts.length >= 2 ? attempts[attempts.length - 2] : undefined
    const noProgress = previous?.candidateSha !== undefined && previous.candidateSha === attempt.candidateSha
    if (record.repairRounds + 1 > maxRepair || (noProgress ? record.noProgressRounds + 1 : 0) > maxNoProgress) {
      const handed = await requestHandoff({
        callerSessionID: input.callerSessionID,
        caseId: input.caseId,
        reason: `rework limit reached: ${input.reason}`,
      })
      return {
        attemptId: handed.activeAttemptId ?? attemptId,
        repairRounds: record.repairRounds,
        noProgressRounds: record.noProgressRounds,
        handedOff: true,
      }
    }
    const rotated = await OrynStore.rotateAttempt({
      caseId: input.caseId,
      fromAttemptId: attemptId,
      invalidationReason: input.reason,
      nextBaselineSha: attempt.candidateSha,
      countRepair: true,
      countNoProgress: noProgress,
    })
    return {
      attemptId: rotated.next.id,
      repairRounds: rotated.case.repairRounds,
      noProgressRounds: rotated.case.noProgressRounds,
      handedOff: false,
    }
  }

  /**
   * Deterministic delivery gate (proposal §9): control state, version
   * consistency, trusted evidence, CI status, independent review closure,
   * payload completeness, and secret leakage. CI status and the payload
   * arrive from the caller (the controlled publisher), so the gate stays
   * locally checkable and fails closed on unknowns.
   */
  export async function evaluateDelivery(input: {
    callerSessionID: string
    caseId: string
    attemptId?: string
    ciStatus?: "passed" | "failed" | "not_applicable"
    payload?: string
  }): Promise<{ ready: boolean; failures: Array<{ code: string; message: string }> }> {
    await requireEnabled()
    const binding = await requireBinding(input.callerSessionID, ["engineering"])
    if (binding.caseId !== input.caseId) {
      throw storeError("NOT_AUTHORIZED", "case does not belong to this engineering session")
    }
    const record = await OrynStore.getCase(input.caseId)
    if (!record) throw storeError("NOT_AUTHORIZED", `case ${input.caseId} not found`)
    if (record.engineeringSessionId !== input.callerSessionID)
      throw storeError("NOT_AUTHORIZED", "caller is not the case engineering root")
    const failures: Array<{ code: string; message: string }> = []
    const budget = await OrynBudget.reason(record)
    if (budget) failures.push({ code: "BUDGET_EXHAUSTED", message: budget })

    if (record.control !== "active") {
      failures.push({ code: "HUMAN_OWNED", message: `case is ${record.control}` })
    }

    const attemptId = input.attemptId ?? record.activeAttemptId
    if (attemptId !== record.activeAttemptId)
      failures.push({ code: "STALE_HEAD", message: "attempt is not the active candidate" })
    const attempt = attemptId ? await OrynStore.getAttempt(input.caseId, attemptId) : undefined
    if (!attempt) {
      failures.push({ code: "INVALID_STAGE", message: "no active attempt" })
    } else {
      if (!attempt.candidateSha) {
        failures.push({ code: "INVALID_STAGE", message: "attempt has no frozen candidate" })
      }
      if (attempt.disposition !== "candidate_frozen" && attempt.disposition !== "ready") {
        failures.push({ code: "INVALID_STAGE", message: `attempt disposition is ${attempt.disposition}` })
      }

      const assignments = await OrynStore.listAssignments(input.caseId)
      const reports = await OrynStore.listWorkerReports(input.caseId)
      let baselineFailed = false
      let cleanCandidatePass = false
      for (const report of reports) {
        if (report.kind !== "repro" && report.kind !== "verification") continue
        const assignment = assignments.find(
          (item) =>
            item.id === report.assignmentId &&
            item.acceptedReportId === report.id &&
            item.attemptId === report.attemptId &&
            item.epoch === record.epoch &&
            report.epoch === record.epoch &&
            item.stage === (report.kind === "repro" ? "repro" : "verify"),
        )
        if (!assignment) continue
        const sourceAttempt = await OrynStore.getAttempt(input.caseId, report.attemptId)
        if (!sourceAttempt) continue
        try {
          await OrynEvidence.reportRuns({ assignment, attempt: sourceAttempt, report })
          if (report.kind === "repro" && report.outcome === "reproduced") baselineFailed = true
          if (
            report.kind === "verification" &&
            report.attemptId === attempt.id &&
            ["verified", "passed"].includes(report.outcome)
          )
            cleanCandidatePass = true
        } catch {
          failures.push({ code: "EVIDENCE_INSUFFICIENT", message: "accepted report has invalid execution evidence" })
        }
      }
      const runs = (await OrynStore.listRuns(input.caseId)).filter((r) => r.attemptId === attempt.id)
      const unresolved = runs.filter((r) => r.outcome === "inconclusive" || r.outcome === "cancelled")
      if (record.kind === "bug" && !baselineFailed) {
        failures.push({ code: "EVIDENCE_INSUFFICIENT", message: "bug cases require a failing baseline run" })
      }
      if (!cleanCandidatePass) {
        failures.push({
          code: "EVIDENCE_INSUFFICIENT",
          message: "no independent verification report with a clean passing candidate run",
        })
      }
      if (unresolved.length > 0) {
        failures.push({
          code: "EVIDENCE_INSUFFICIENT",
          message: `${unresolved.length} inconclusive or cancelled run(s) unresolved`,
        })
      }

      try {
        const candidate = reports.find(
          (report) =>
            report.kind === "candidate" &&
            report.attemptId === attempt.id &&
            report.candidateSha === attempt.candidateSha &&
            assignments.some(
              (assignment) =>
                assignment.id === report.assignmentId &&
                assignment.attemptId === attempt.id &&
                assignment.epoch === record.epoch &&
                assignment.stage === "code" &&
                assignment.acceptedReportId === report.id,
            ),
        )
        if (!candidate) throw storeError("INVALID_STAGE", "no accepted candidate report")
        await OrynCandidate.verify({
          assignment: assignments.find((assignment) => assignment.id === candidate.assignmentId)!,
          attempt,
          candidateSha: candidate.candidateSha,
          localBranch: candidate.localBranch,
        })
      } catch {
        failures.push({
          code: "STALE_HEAD",
          message: "candidate verification: accepted worktree or commit is no longer valid",
        })
      }
      const requiredDomains = new Set<ReviewDomain>([
        "general",
        ...assignments.filter((item) => item.stage === "review").map((item) => item.reviewDomain ?? "general"),
      ])
      try {
        for (const domain of (await OrynReviewPolicy.requirements(record, attempt)).domains) requiredDomains.add(domain)
      } catch {
        failures.push({
          code: "STALE_HEAD",
          message: "required review domains could not be verified from the candidate",
        })
      }
      const accepted = new Map(
        assignments
          .filter(
            (item) =>
              item.stage === "review" &&
              item.agentId === "oryn-review" &&
              item.epoch === record.epoch &&
              item.attemptId === attempt.id,
          )
          .map((item) => [item.acceptedReportId, item]),
      )
      const reviews = (await OrynStore.listReviews(input.caseId))
        .filter((report) => {
          const assignment = accepted.get(report.id)
          return (
            report.attemptId === attempt.id &&
            report.assignmentId === assignment?.id &&
            report.domain === (assignment.reviewDomain ?? "general") &&
            attempt.reviewIds.includes(report.id)
          )
        })
        .sort((left, right) => attempt.reviewIds.indexOf(left.id) - attempt.reviewIds.indexOf(right.id))
      const { evidenceDigest, policyDigest } = OrynEvidence.reviewDigests(record, attempt)
      for (const domain of requiredDomains) {
        const latest = reviews.filter((report) => report.domain === domain).at(-1)
        if (!latest) {
          failures.push({ code: "EVIDENCE_INSUFFICIENT", message: `no review for the frozen candidate in ${domain}` })
          continue
        }
        if (
          latest.headSha !== attempt.candidateSha ||
          latest.baseSha !== attempt.baselineSha ||
          latest.policyDigest !== policyDigest ||
          latest.evidenceDigest !== evidenceDigest ||
          accepted.get(latest.id)?.frozenInputsDigest !== OrynEvidence.assignmentDigest(record, attempt, "review")
        ) {
          failures.push({ code: "STALE_HEAD", message: `${domain} review snapshot is stale` })
        }
        if (latest.recommendation !== "ready_for_human")
          failures.push({
            code: "EVIDENCE_INSUFFICIENT",
            message: `${domain} reviewer recommendation is ${latest.recommendation}`,
          })
        const blockers = latest.findings.filter(
          (finding) => ["open", "still_open"].includes(finding.disposition) && ["P0", "P1"].includes(finding.severity),
        )
        if (blockers.length)
          failures.push({
            code: "EVIDENCE_INSUFFICIENT",
            message: `${domain}: ${blockers.length} open blocker finding(s)`,
          })
        if (latest.questions.length || latest.designDecisions.length)
          failures.push({
            code: "HUMAN_OWNED",
            message: `${domain} unresolved questions or design decisions require an owner`,
          })
      }
    }

    if (input.ciStatus === undefined) {
      failures.push({ code: "EVIDENCE_INSUFFICIENT", message: "CI status unknown; fail-closed" })
    } else if (input.ciStatus === "failed") {
      failures.push({ code: "EVIDENCE_INSUFFICIENT", message: "CI failed on the candidate" })
    }

    const payload = input.payload
    if (!payload) {
      failures.push({ code: "EVIDENCE_INSUFFICIENT", message: "delivery payload missing" })
    } else {
      if (attempt?.candidateSha && !payload.includes(attempt.candidateSha)) {
        failures.push({ code: "STALE_HEAD", message: "payload does not reference the frozen candidate" })
      }
      for (const label of OrynPublicText.violations(payload)) {
        failures.push({ code: "NOT_AUTHORIZED", message: `payload contains ${label}` })
      }
    }

    return { ready: failures.length === 0, failures }
  }

  /**
   * Worker proposes a verification plan. The host validates the assignment
   * binding; the plan stays proposed until the executor approves it on run.
   */
  export async function proposeCheck(input: {
    callerSessionID: string
    caseId: string
    attemptId: string
    assignmentId: string
    scenario: string
    profileId: string
    argv: string[][]
    checks: string[]
    overlay?: boolean
    patch?: string
  }): Promise<{ planId: string }> {
    await requireEnabled()
    const binding = await requireBinding(input.callerSessionID, ["worker"])
    if (binding.caseId !== input.caseId) {
      throw storeError("NOT_AUTHORIZED", "case does not belong to this session")
    }
    const assignment = await OrynStore.getAssignment(input.caseId, input.assignmentId)
    if (!assignment) throw storeError("NOT_AUTHORIZED", `assignment ${input.assignmentId} not found`)
    if (assignment.sessionId !== input.callerSessionID) {
      throw storeError("NOT_AUTHORIZED", "assignment does not belong to this session")
    }
    if (assignment.attemptId !== input.attemptId) {
      throw storeError("INVALID_STAGE", "assignment belongs to a different attempt")
    }
    const plan = await OrynStore.writeCheckPlan({
      caseId: input.caseId,
      attemptId: input.attemptId,
      scenario: input.scenario,
      profileId: input.profileId,
      argv: input.argv,
      checks: input.checks,
      proposedBySessionId: input.callerSessionID,
      overlay: input.overlay ?? Boolean(input.patch),
      patch: input.patch,
    })
    return { planId: plan.id }
  }

  /**
   * Execute a check plan through the trusted executor. The working directory
   * is the caller session's host-assigned workspace, never a model parameter.
   */
  export async function runCheck(input: {
    callerSessionID: string
    caseId: string
    attemptId: string
    assignmentId: string
    planId: string
    lane: RunReceipt["lane"]
    abort: AbortSignal
  }): Promise<{ runId: string; outcome: RunReceipt["outcome"]; overlayApplied: boolean }> {
    await requireEnabled()
    return OrynExecutor.run(input)
  }

  /** Binding-scoped check plan read for workers and the engineering root. */
  export async function getCheck(input: { callerSessionID: string; caseId: string; planId: string }) {
    await requireEnabled()
    const binding = await requireBinding(input.callerSessionID, ["worker", "engineering"])
    if (binding.caseId !== input.caseId) {
      throw storeError("NOT_AUTHORIZED", "case does not belong to this session")
    }
    const plan = await OrynStore.getCheckPlan(input.caseId, input.planId)
    if (!plan) throw storeError("NOT_AUTHORIZED", `check plan ${input.planId} not found`)
    return plan
  }

  /**
   * Bounded delivery intent. The model never names a chat or account; the
   * target is the Host-bound source. Conversation replies deduplicate per
   * root turn; readiness per Host publication conclusion, persisted human
   * handoffs per ownership epoch, and other lifecycle notices per attempt.
   */
  export async function reply(input: {
    callerSessionID: string
    turnID?: string
    caseId?: string
    kind: "answer" | "clarification" | "accepted" | "needs_human" | "ready" | "released"
    text: string
  }): Promise<{ entryId: string; created: boolean }> {
    await requireEnabled()
    const binding = await requireBinding(input.callerSessionID, ["qa", "engineering"])
    if (binding.role === "engineering") {
      if (
        !binding.caseId ||
        (input.caseId && input.caseId !== binding.caseId) ||
        !["answer", "clarification"].includes(input.kind)
      )
        throw storeError("NOT_AUTHORIZED", "Engineering replies require their bound GitHub source")
      const work = await OrynGithubStore.get(binding.caseId)
      const record = await requireActiveCase(binding.caseId)
      if (record.engineeringSessionId !== input.callerSessionID || OrynPublicText.violations(input.text).length)
        throw storeError("NOT_AUTHORIZED", "GitHub reply authority or text is invalid")
      let identity = work?.mode === "issue" && work.state !== "stopped" ? binding.identity : undefined
      let version = work?.fingerprint
      if (!identity && input.turnID) {
        const message = (await MessageV2.get({ sessionID: input.callerSessionID, messageID: input.turnID })).info
        const repository = (await OrynConfig.info())?.repositories?.[record.repoAlias]
        const number = message.metadata?.orynGithubNumber
        if (
          message.role === "user" &&
          message.origin?.type === "system" &&
          message.origin.detail === "oryn_github_owned" &&
          typeof number === "number" &&
          (number === record.issueNumber || record.pullNumbers.includes(number)) &&
          repository?.githubAccount &&
          message.metadata?.orynGithubRepository === `${repository.owner}/${repository.repo}` &&
          typeof message.metadata?.orynGithubFingerprint === "string"
        ) {
          identity = {
            provider: "github",
            accountId: repository.githubAccount,
            repo: `${repository.owner}/${repository.repo}`,
            issueNumber: number,
            chatId: `${repository.owner}/${repository.repo}#${number}`,
          }
          version = message.metadata.orynGithubFingerprint
        }
      }
      if (
        identity?.provider !== "github" ||
        !identity.repo ||
        !version ||
        !(await OrynGithub.binding(identity.accountId, identity.repo))
      )
        throw storeError("NOT_AUTHORIZED", "The current turn has no authorized GitHub reply target")
      await OrynStore.recordSource({ identity })
      const key = sourceKey(identity)
      await OrynStore.linkSourceToCase(key, record.id)
      const { entry, created } = await OrynStore.writeOutbox({
        caseId: record.id,
        sourceKeyHash: key,
        kind: input.kind,
        text: input.text,
        dedupKey: `github-reply:${version}:${input.kind}`,
      })
      if (work?.mode === "issue") {
        using lock = await Lock.write(`oryn-github-thread:${work.repository}:${work.number}`)
        const current = await OrynGithubStore.get(work.caseId)
        if (current?.fingerprint === version) await OrynGithubStore.save({ ...current, state: "settled" })
      }
      return { entryId: entry.id, created }
    }
    const caseId = input.caseId ?? binding.caseId
    if (caseId && binding.caseId && binding.caseId !== caseId) {
      throw storeError("NOT_AUTHORIZED", "case does not belong to this session")
    }
    const record = caseId ? await OrynStore.getCaseForSession(caseId, input.callerSessionID) : undefined
    const turn = input.turnID ? await OrynStore.channelTurn(input.callerSessionID, input.turnID) : undefined
    if (input.turnID && !turn && (await OrynStore.channelSource(binding.sourceKey))) {
      throw storeError("NOT_AUTHORIZED", "reply turn has no durable Channel source")
    }
    if (
      turn &&
      (turn.qaSessionId !== input.callerSessionID ||
        turn.identity.accountId !== binding.identity?.accountId ||
        turn.identity.chatId !== binding.identity?.chatId ||
        turn.identity.threadId !== binding.identity?.threadId)
    ) {
      throw storeError("NOT_AUTHORIZED", "reply turn does not belong to this source")
    }
    if (input.kind === "needs_human" && record?.handoff) {
      const notices = await queueHandoffNotifications(record)
      for (const notice of notices) {
        const channel = await OrynStore.channelSource(notice.entry.sourceKey)
        if (channel?.qaSessionId === input.callerSessionID) return { entryId: notice.entry.id, created: notice.created }
      }
      throw storeError("NOT_AUTHORIZED", "handoff has no current authorized notification source")
    }
    if (input.kind === "ready") {
      if (!caseId) throw storeError("NOT_AUTHORIZED", "readiness requires an acknowledged Case publication")
      for (const notice of await queueReadyNotifications(caseId)) {
        if ((await OrynStore.channelSource(notice.entry.sourceKey))?.qaSessionId === input.callerSessionID)
          return { entryId: notice.entry.id, created: notice.created }
      }
      throw storeError("EVIDENCE_INSUFFICIENT", "Case has no current acknowledged ready result for this reporter")
    }
    const replySourceKey = turn ? sourceKey(turn.identity) : binding.sourceKey
    const conversational = input.kind === "answer" || input.kind === "clarification"
    if (conversational && !input.turnID) {
      throw storeError("NOT_AUTHORIZED", "a reply must be bound to its host-owned root turn")
    }
    const version = conversational ? input.turnID : (record?.activeAttemptId ?? "intake")
    const dedupKey = externalIdentityHash(binding.sourceKey, caseId ?? "", input.kind, version ?? "")
    const { entry, created } = await OrynStore.writeOutbox({
      caseId,
      sourceKeyHash: replySourceKey,
      kind: input.kind,
      text: input.text,
      dedupKey,
    })
    return { entryId: entry.id, created }
  }

  type OutboxDeliverer = (input: {
    sourceKey: string
    identity: SourceIdentity
    kind: string
    text: string
  }) => Promise<void>

  let deliverer: OutboxDeliverer | undefined
  let canDeliver: ((input: { sourceKey: string; identity: SourceIdentity }) => Promise<boolean>) | undefined

  /** L4 assembly injection: the product wiring provides the real provider delivery. */
  export function setOutboxDeliverer(
    fn: OutboxDeliverer | undefined,
    ready?: (input: { sourceKey: string; identity: SourceIdentity }) => Promise<boolean>,
  ): void {
    deliverer = fn
    canDeliver = ready
  }

  async function claimNotification(
    entry: OutboxEntry,
    available: boolean,
    proof?: OrynReady.Projection,
  ): Promise<"claimed" | "suppressed" | "pending"> {
    using _case = entry.caseId ? await Lock.write(`oryn-case:${entry.caseId}`) : undefined
    const record = entry.caseId ? await OrynStore.getCase(entry.caseId) : undefined
    using _attempt =
      record?.activeAttemptId && entry.kind === "ready"
        ? await Lock.write(`oryn-attempt:${record.id}:${record.activeAttemptId}`)
        : undefined
    const suppress = async () => {
      await OrynStore.markOutboxSuppressed(entry.id)
      return "suppressed" as const
    }
    const config = await OrynConfig.info()
    if (!config?.enabled) return "pending"
    if (config.notifications?.kinds && !config.notifications.kinds.includes(entry.kind)) return suppress()
    const link = await OrynStore.getSource(entry.sourceKey)
    if (!link) return suppress()
    if (link.identity.eventName === "oryn_operator" && !(await OrynNotifications.operator(link.identity)))
      return suppress()
    if (link.identity.provider === "github" && record) {
      if (record.control !== "active") return suppress()
      const work = await OrynGithubStore.get(record.id)
      if (
        work?.mode === "issue" &&
        entry.dedupKey.startsWith("github-reply:") &&
        !entry.dedupKey.startsWith(`github-reply:${work.fingerprint}:`)
      )
        return suppress()
    }
    if (entry.kind === "ready" || (entry.caseId && entry.kind === "needs_human")) {
      const ready = entry.kind === "ready" && entry.caseId ? await OrynReady.projection(entry.caseId) : undefined
      const current =
        record &&
        record.sourceIds.includes(entry.sourceKey) &&
        link.caseIds.includes(record.id) &&
        (entry.kind === "needs_human"
          ? record.control === "human_owned" &&
            record.handoff?.epoch === record.epoch &&
            entry.dedupKey === groupKey(await handoffGroup(record, entry.sourceKey))
          : ready?.dedupKey === entry.dedupKey && ready.text === entry.text)
      if (!current) return suppress()
      if (!(await reporter(record, entry.sourceKey))) return "pending"
      if (
        entry.kind === "ready" &&
        (!proof || proof.dedupKey !== ready?.dedupKey || proof.policyDigest !== ready.policyDigest)
      )
        return "pending"
    }
    if (!available) return "pending"
    return (await OrynStore.claimOutboxDelivery(entry.id)) ? "claimed" : "pending"
  }

  /**
   * Transport readiness precedes the locked local claim. A takeover before
   * that claim prevents dispatch; a claimed send remains ambiguous until its
   * transport acknowledges, without holding the Case lock across the network.
   */
  export async function drainOutbox(): Promise<{ delivered: number; suppressed: number }> {
    const config = await OrynConfig.info()
    if (!config?.enabled) return { delivered: 0, suppressed: 0 }
    const pending = await OrynStore.listPendingOutbox()
    let delivered = 0
    let suppressed = 0
    for (const entry of pending) {
      const send = deliverer
      const link = await OrynStore.getSource(entry.sourceKey)
      if (!link) {
        await OrynStore.markOutboxSuppressed(entry.id)
        suppressed++
        continue
      }
      const available =
        !!send && (!canDeliver || (await canDeliver({ sourceKey: entry.sourceKey, identity: link.identity })))
      const ready =
        available && entry.kind === "ready" && entry.caseId ? await OrynReady.projection(entry.caseId) : undefined
      const proof = ready && (await OrynReady.confirm(ready)) ? ready : undefined
      const claim = await claimNotification(entry, available, proof)
      if (claim === "suppressed") suppressed++
      if (claim !== "claimed" || !send) continue
      try {
        await send({
          sourceKey: entry.sourceKey,
          identity: link.identity,
          kind: entry.kind,
          text: entry.text,
        })
        await OrynStore.markOutboxDelivered(entry.id)
        delivered++
      } catch {
        // The transport may have accepted the message; only a confirmed
        // receipt can settle this intent, never an automatic resend.
      }
    }
    return { delivered, suppressed }
  }
}
