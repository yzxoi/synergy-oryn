import { externalIdentityHash } from "../util/identity"
import { Session } from "../session"
import { SessionInteraction } from "../session/interaction"
import { SessionInbox } from "../session/inbox"
import { SessionManager } from "../session/manager"
import { BossService } from "../boss/boss"
import { OrynStore, sourceKey, storeError } from "./store"
import { OrynConfig } from "./config"
import { Finding as FindingSchema } from "./schema"
import type { Finding, ReviewDomain, RunReceipt, SourceIdentity, Stage } from "./schema"
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
  return record
}
async function assertStageAdmission(caseId: string, attemptId: string, stage: Stage): Promise<void> {
  const reports = await OrynStore.listWorkerReports(caseId)
  if (stage === "code") {
    // Reproduction is per-case evidence: after a rework rotation the new
    // attempt inherits the confirmed bug, so any accepted reproduction on
    // the case admits coding.
    const reproduced = reports.some(
      (r) => r.kind === "repro" && (r.outcome === "reproduced" || r.outcome === "already_fixed"),
    )
    if (!reproduced) {
      throw storeError("INVALID_STAGE", "code requires an accepted reproduction on this case", { caseId })
    }
    return
  }
  if (stage === "verify" || stage === "review") {
    const attemptReports = reports.filter((r) => r.attemptId === attemptId)
    const frozen = attemptReports.some((r) => r.kind === "candidate" && r.candidateSha)
    if (!frozen) {
      throw storeError("INVALID_STAGE", `${stage} requires a frozen candidate on this attempt`, { caseId })
    }
  }
}

function taskText(input: {
  caseId: string
  attemptId: string
  assignmentId: string
  stage: Stage
  summary: string
  observed?: string
  expected?: string
}): string {
  const lines = [
    `Oryn assignment ${input.assignmentId} (stage: ${input.stage})`,
    `Case: ${input.caseId}`,
    `Summary: ${input.summary}`,
    input.observed ? `Observed: ${input.observed}` : undefined,
    input.expected ? `Expected: ${input.expected}` : undefined,
    "",
    "Complete the assignment inside your assigned scope. Submit the structured outcome with oryn_result submit (caseId, attemptId, assignmentId above). Cite run receipts for any claim about tests. If you cannot proceed, submit a result with the specific blocker instead of guessing.",
  ]
  return lines.filter((line) => line !== undefined).join("\n")
}

export namespace OrynService {
  /**
   * Host intake for a QA-submitted engineering case. Identity and routing
   * come from the Host-written session binding and config routes, never from
   * model input. Idempotent per requestKey; a new requestKey from the same
   * topic opens a new case.
   */
  export async function submitCase(input: {
    callerSessionID: string
    requestKey: string
    kind: "bug" | "feature" | "question" | "performance" | "usage"
    summary: string
    observed?: string
    expected?: string
  }): Promise<{ caseId: string; revision: number; created: boolean; repoAlias: string }> {
    await requireEnabled()
    const binding = await requireBinding(input.callerSessionID, ["qa"])
    const identity = feishuIdentity(binding)
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
    return { caseId: record.id, revision: record.revision, created, repoAlias }
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
    await requireEnabled()
    const record = await OrynStore.getCase(input.caseId)
    if (!record) throw storeError("NOT_AUTHORIZED", `case ${input.caseId} not found`)
    if (record.engineeringSessionId) {
      const attempt = await OrynStore.ensureAttempt(input.caseId, {
        baselineSha: input.baselineSha,
        baseBranchSha: input.baseBranchSha,
      })
      return { sessionID: record.engineeringSessionId, attemptId: attempt.id }
    }
    const session = await Session.create({
      title: `Oryn ${input.caseId}`,
      agentOverride: "oryn-work",
      interaction: SessionInteraction.unattended("oryn"),
      workflow: { kind: "boss", role: "boss" },
    })
    await OrynStore.attachEngineeringSession(input.caseId, session.id)
    await OrynStore.bindSessionSource({
      sessionID: session.id,
      identity: input.identity,
      caseId: input.caseId,
      role: "engineering",
    })
    const attempt = await OrynStore.ensureAttempt(input.caseId, {
      baselineSha: input.baselineSha,
      baseBranchSha: input.baseBranchSha,
    })
    return { sessionID: session.id, attemptId: attempt.id }
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
    const binding = await requireBinding(input.callerSessionID, ["engineering"])
    if (binding.caseId !== input.caseId) {
      throw storeError("NOT_AUTHORIZED", "case does not belong to this engineering session")
    }
    const record = await requireActiveCase(input.caseId)
    if (record.engineeringSessionId !== input.callerSessionID) {
      throw storeError("NOT_AUTHORIZED", "caller is not the case engineering root")
    }
    const attemptId = input.attemptId ?? record.activeAttemptId
    if (!attemptId) throw storeError("INVALID_STAGE", "case has no active attempt", { caseId: input.caseId })
    const attempt = await OrynStore.getAttempt(input.caseId, attemptId)
    if (!attempt) throw storeError("NOT_AUTHORIZED", `attempt ${attemptId} not found`)
    if (
      attempt.disposition === "superseded" ||
      attempt.disposition === "failed" ||
      attempt.disposition === "handed_off"
    ) {
      throw storeError("INVALID_STAGE", `attempt is ${attempt.disposition}`, { caseId: input.caseId })
    }
    await assertStageAdmission(input.caseId, attemptId, input.stage)

    const existing = await OrynStore.findAssignmentByRequestKey(input.caseId, attemptId, input.requestKey)
    if (existing?.sessionId) {
      return { assignmentId: existing.id, workerSessionId: existing.sessionId, deduped: true }
    }

    const frozenInputsDigest = externalIdentityHash(
      attempt.baselineSha,
      attempt.candidateSha ?? "",
      record.acceptanceDigest,
      input.stage,
    )
    const assignment = await OrynStore.createAssignment({
      caseId: input.caseId,
      attemptId,
      stage: input.stage,
      agentId: STAGE_AGENT[input.stage],
      frozenInputsDigest,
      epoch: record.epoch,
      reviewDomain: input.reviewDomain,
      requestKey: input.requestKey,
    })

    const worker = await BossService.spawn(input.callerSessionID, {
      role: input.stage,
      agent: STAGE_AGENT[input.stage],
      instructions: `Oryn case ${input.caseId}: ${input.stage} assignment.`,
      // The code worker's worktree is pinned to the attempt baseline so the
      // candidate branch shares the frozen base — never the caller's moving
      // current checkout HEAD.
      ...(input.stage === "code" ? { workspace: "worktree" as const, baseRevision: attempt.baselineSha } : {}),
    })
    await OrynStore.setAssignmentSession(input.caseId, assignment.id, worker.id)
    if (input.stage === "code" && worker.workspace?.type === "git_worktree") {
      await OrynStore.setAssignmentWorkspace(input.caseId, assignment.id, worker.workspace.path)
    }
    if (binding.identity) {
      await OrynStore.bindSessionSource({
        sessionID: worker.id,
        identity: binding.identity,
        caseId: input.caseId,
        role: "worker",
      })
    }

    const delivery = await SessionInbox.deliverUnique({
      sessionID: worker.id,
      deliveryKey: `oryn:${assignment.id}`,
      mode: "task",
      message: {
        role: "user",
        agent: STAGE_AGENT[input.stage],
        origin: { type: "system", detail: "oryn_assign" },
        visible: true,
        parts: [
          {
            type: "text",
            text: taskText({
              caseId: input.caseId,
              attemptId,
              assignmentId: assignment.id,
              stage: input.stage,
              summary: record.summary,
              observed: record.observed,
              expected: record.expected,
            }),
          },
        ],
        metadata: {
          orynCaseId: input.caseId,
          orynAttemptId: attemptId,
          orynAssignmentId: assignment.id,
        },
        summary: { title: `Oryn ${input.stage} assignment` },
      },
    })
    if (delivery.created) SessionManager.scheduleWake(worker.id, "oryn_assign")
    return { assignmentId: assignment.id, workerSessionId: worker.id, deduped: false }
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
    await requireBinding(input.callerSessionID, ["worker"])
    const assignment = await OrynStore.getAssignment(input.caseId, input.assignmentId)
    if (!assignment) throw storeError("NOT_AUTHORIZED", `assignment ${input.assignmentId} not found`)
    if (assignment.sessionId !== input.callerSessionID) {
      throw storeError("NOT_AUTHORIZED", "assignment does not belong to this session")
    }
    if (assignment.attemptId !== input.attemptId) {
      throw storeError("INVALID_STAGE", "assignment belongs to a different attempt")
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

    if (record.epoch !== assignment.epoch) {
      return { reportId: report.id, accepted: false, stale: true }
    }

    await OrynStore.acceptAssignmentReport(input.caseId, input.assignmentId, report.id)
    if (input.kind === "candidate" && input.candidateSha) {
      await OrynStore.mutateAttempt(input.caseId, input.attemptId, (draft) => ({
        ...draft,
        candidateSha: input.candidateSha!,
        disposition: "candidate_frozen",
      }))
    }
    for (const runId of input.runIds ?? []) {
      await OrynStore.attachRunEvidence(input.caseId, input.attemptId, runId)
    }
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
    await requireBinding(input.callerSessionID, ["worker"])
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
    const prior = (await OrynStore.listReviews(input.caseId))
      .filter((r) => r.attemptId !== input.attemptId)
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
    const report = await OrynStore.writeReview({
      assignmentId: input.assignmentId,
      caseId: input.caseId,
      attemptId: input.attemptId,
      headSha: input.headSha,
      baseSha: input.baseSha,
      policyDigest: externalIdentityHash(record.acceptanceDigest),
      evidenceDigest: externalIdentityHash(JSON.stringify(attempt.evidenceRunIds)),
      domain: input.domain ?? "general",
      findings,
      questions: input.questions ?? [],
      evidenceAssessment: input.evidenceAssessment,
      designDecisions: input.designDecisions ?? [],
      recommendation: input.recommendation,
      ...(input.limitedScope ? { limitedScope: input.limitedScope } : {}),
    })
    if (record.epoch !== assignment.epoch) {
      return { reviewId: report.id, accepted: false, stale: true }
    }
    await OrynStore.acceptAssignmentReport(input.caseId, input.assignmentId, report.id)
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
      const handed = await OrynStore.requestHandoff(input.caseId, `rework limit reached: ${input.reason}`)
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
    const failures: Array<{ code: string; message: string }> = []

    if (record.control !== "active") {
      failures.push({ code: "HUMAN_OWNED", message: `case is ${record.control}` })
    }

    const attemptId = input.attemptId ?? record.activeAttemptId
    const attempt = attemptId ? await OrynStore.getAttempt(input.caseId, attemptId) : undefined
    if (!attempt) {
      failures.push({ code: "INVALID_STAGE", message: "no active attempt" })
    } else {
      if (!attempt.candidateSha) {
        failures.push({ code: "INVALID_STAGE", message: "attempt has no frozen candidate" })
      }
      if (attempt.disposition !== "candidate_frozen") {
        failures.push({ code: "INVALID_STAGE", message: `attempt disposition is ${attempt.disposition}` })
      }

      const runs = (await OrynStore.listRuns(input.caseId)).filter((r) => r.attemptId === attempt.id)
      const baselineFailed = runs.some((r) => r.lane === "baseline" && r.outcome === "failed")
      const cleanCandidatePass = runs.some(
        (r) =>
          r.lane === "candidate" && r.outcome === "passed" && !r.overlayApplied && r.actualSha === attempt.candidateSha,
      )
      const unresolved = runs.filter((r) => r.outcome === "inconclusive" || r.outcome === "cancelled")
      if (record.kind === "bug" && !baselineFailed) {
        failures.push({ code: "EVIDENCE_INSUFFICIENT", message: "bug cases require a failing baseline run" })
      }
      if (!cleanCandidatePass) {
        failures.push({
          code: "EVIDENCE_INSUFFICIENT",
          message: "no clean passing candidate run on the frozen candidate",
        })
      }
      if (unresolved.length > 0) {
        failures.push({
          code: "EVIDENCE_INSUFFICIENT",
          message: `${unresolved.length} inconclusive or cancelled run(s) unresolved`,
        })
      }

      const reviews = (await OrynStore.listReviews(input.caseId)).filter(
        (r) => r.attemptId === attempt.id && r.headSha === attempt.candidateSha,
      )
      const sorted = reviews.sort((a, b) => a.createdAt - b.createdAt)
      const latest = sorted.length > 0 ? sorted[sorted.length - 1] : undefined
      if (!latest) {
        failures.push({ code: "EVIDENCE_INSUFFICIENT", message: "no review for the frozen candidate" })
      } else {
        if (latest.recommendation !== "ready_for_human") {
          failures.push({
            code: "EVIDENCE_INSUFFICIENT",
            message: `reviewer recommendation is ${latest.recommendation}`,
          })
        }
        const blockers = latest.findings.filter(
          (f) =>
            (f.disposition === "open" || f.disposition === "still_open") &&
            (f.severity === "P0" || f.severity === "P1"),
        )
        if (blockers.length > 0) {
          failures.push({ code: "EVIDENCE_INSUFFICIENT", message: `${blockers.length} open blocker finding(s)` })
        }
        if (latest.designDecisions.length > 0) {
          failures.push({ code: "HUMAN_OWNED", message: "unresolved design decisions require an owner" })
        }
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
      const secretPatterns: Array<[RegExp, string]> = [
        [/ghp_[A-Za-z0-9]{10,}/, "a GitHub token"],
        [/github_pat_[A-Za-z0-9_]{10,}/, "a fine-grained GitHub token"],
        [/sk-[A-Za-z0-9-]{10,}/, "an API key"],
        [/\bses_[a-zA-Z0-9]{8,}\b/, "an internal session id"],
        [/\borc_[a-zA-Z0-9]{8,}\b/, "an internal case id"],
        [/(\/Users\/|\/home\/)[A-Za-z0-9._-]+/, "an absolute home path"],
      ]
      for (const [pattern, label] of secretPatterns) {
        if (pattern.test(payload)) {
          failures.push({ code: "NOT_AUTHORIZED", message: `payload contains ${label}` })
        }
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
      overlay: input.overlay ?? false,
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
    const session = await Session.get(input.callerSessionID).catch(() => undefined)
    const cwd = session?.workspace?.path
    if (!cwd) throw storeError("ENVIRONMENT_UNAVAILABLE", "session has no workspace to execute checks in")
    return OrynExecutor.run({ ...input, cwd })
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
   * target is the Host-bound source. Dedup key keeps repeated ready /
   * needs_human notifications to one delivery per kind per case.
   */
  export async function reply(input: {
    callerSessionID: string
    caseId?: string
    kind: "answer" | "clarification" | "accepted" | "needs_human" | "ready" | "released"
    text: string
  }): Promise<{ entryId: string; created: boolean }> {
    await requireEnabled()
    const binding = await requireBinding(input.callerSessionID, ["qa", "engineering"])
    const caseId = input.caseId ?? binding.caseId
    if (caseId && binding.caseId && binding.caseId !== caseId) {
      throw storeError("NOT_AUTHORIZED", "case does not belong to this session")
    }
    const dedupKey = `${caseId ?? binding.sourceKey}:${input.kind}`
    const { entry, created } = await OrynStore.writeOutbox({
      caseId,
      sourceKeyHash: binding.sourceKey,
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

  /** L4 assembly injection: the product wiring provides the real provider delivery. */
  export function setOutboxDeliverer(fn: OutboxDeliverer): void {
    deliverer = fn
  }

  /**
   * Drain pending outbox entries through the injected deliverer. Delivery is
   * at-least-once with durable state: entries stay pending until the
   * deliverer resolves, so a crash redelivers rather than loses.
   */
  export async function drainOutbox(): Promise<{ delivered: number; suppressed: number }> {
    const pending = await OrynStore.listPendingOutbox()
    let delivered = 0
    let suppressed = 0
    for (const entry of pending) {
      const link = await OrynStore.getSource(entry.sourceKey)
      if (!link) {
        await OrynStore.markOutboxSuppressed(entry.id)
        suppressed++
        continue
      }
      if (!deliverer || !link.identity) continue
      try {
        await deliverer({
          sourceKey: entry.sourceKey,
          identity: link.identity,
          kind: entry.kind,
          text: entry.text,
        })
        await OrynStore.markOutboxDelivered(entry.id)
        delivered++
      } catch {
        // Keep pending for the next drain; delivery stays durable.
      }
    }
    return { delivered, suppressed }
  }
}
