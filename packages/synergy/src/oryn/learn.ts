import { Lock } from "../util/lock"
import { externalIdentityHash } from "../util/identity"
import { OrynStore, OrynStoreError, storeError } from "./store"
import { OrynConfig } from "./config"
import { OrynBudget } from "./budget"
import { OrynReady } from "./ready"
import { OrynEvidence } from "./evidence"
import { Session } from "../session"
import type { LearningCandidate, LearningSource, Case, ReviewReport } from "./schema"

/**
 * Injected verified-memory port. The Oryn domain never imports the Library
 * or the embedding runtime directly; product assembly wires the real
 * LibraryDB.Memory writer, and tests inject fakes. Reward automation is
 * intentionally absent: the upstream Experience reward API lacks event
 * idempotency, so `oryn.learning.autoReward` stays unimplemented by design.
 */
export type MemoryPromoter = {
  promote(
    input: { id: string; title: string; content: string },
    commit: (write: () => string) => Promise<string>,
  ): Promise<string>
  remove(memoryId: string, expected: { title: string; content: string }): Promise<void>
}

let promoter: MemoryPromoter | undefined

/** Product assembly injection. */
export function setMemoryPromoter(fn: MemoryPromoter | undefined): MemoryPromoter | undefined {
  const previous = promoter
  promoter = fn
  return previous
}

function memoryInput(candidate: LearningCandidate) {
  return {
    id: candidate.memoryRef ?? `mem_oryn_${externalIdentityHash(candidate.id)}`,
    ...candidate.memory,
  }
}

async function learningSource(record: Case, refs: string[]): Promise<LearningSource | undefined> {
  if (!record.activeAttemptId || refs.length === 0 || refs.length > 16) return
  const attempt = await OrynStore.getAttempt(record.id, record.activeAttemptId)
  const repo = (await OrynConfig.info())?.repositories?.[record.repoAlias]
  if (!attempt || !repo) return
  const [assignments, reports, reviews] = await Promise.all([
    OrynStore.listAssignments(record.id),
    OrynStore.listWorkerReports(record.id),
    OrynStore.listReviews(record.id),
  ])
  const accepted = new Map(
    assignments
      .filter((item) => item.epoch === record.epoch && item.attemptId === attempt.id && item.acceptedReportId)
      .map((item) => [item.acceptedReportId, item]),
  )
  const source = {
    repository: `${repo.owner}/${repo.repo}`,
    attemptId: attempt.id,
    epoch: record.epoch,
    acceptanceDigest: record.acceptanceDigest,
    baselineSha: attempt.baselineSha,
    candidateSha: attempt.candidateSha,
  }
  const valid = new Map<string, unknown>([[attempt.id, source]])
  for (const report of reports) {
    const assignment = accepted.get(report.id)
    if (
      !assignment ||
      report.assignmentId !== assignment.id ||
      report.epoch !== record.epoch ||
      report.attemptId !== attempt.id ||
      (report.candidateSha && report.candidateSha !== attempt.candidateSha)
    )
      continue
    try {
      const runs = await OrynEvidence.reportRuns({ assignment, attempt, report })
      if (
        runs.some(
          (run) => run.infrastructureFailure || !["built_runtime", "live_test_tenant"].includes(run.authenticity),
        )
      )
        continue
      valid.set(report.id, report)
      for (const run of runs) {
        if (attempt.evidenceRunIds.includes(run.id) && ["passed", "failed"].includes(run.outcome))
          valid.set(run.id, run)
      }
    } catch (error) {
      if (!(error instanceof OrynStoreError) || error.data.code !== "EVIDENCE_INSUFFICIENT") throw error
    }
  }
  const digests = OrynEvidence.reviewDigests(record, attempt)
  const latestReviews = new Map<string, ReviewReport>()
  for (const review of reviews.sort(
    (left, right) => attempt.reviewIds.indexOf(left.id) - attempt.reviewIds.indexOf(right.id),
  )) {
    const assignment = accepted.get(review.id)
    if (
      !assignment ||
      assignment.stage !== "review" ||
      assignment.agentId !== "oryn-review" ||
      review.assignmentId !== assignment.id ||
      review.attemptId !== attempt.id ||
      !attempt.reviewIds.includes(review.id) ||
      review.domain !== (assignment.reviewDomain ?? "general")
    )
      continue
    latestReviews.set(review.domain, review)
  }
  for (const review of latestReviews.values()) {
    if (
      review.headSha === attempt.candidateSha &&
      review.baseSha === attempt.baselineSha &&
      review.policyDigest === digests.policyDigest &&
      review.evidenceDigest === digests.evidenceDigest &&
      review.recommendation === "ready_for_human"
    )
      valid.set(review.id, review)
  }
  if (refs.some((ref) => !valid.has(ref))) return
  return { ...source, evidenceDigest: externalIdentityHash(JSON.stringify(refs.map((ref) => [ref, valid.get(ref)]))) }
}

function memoryText(
  input: { lesson: string; applicability: string; invalidation: string; evidenceRefs: string[] },
  source: LearningSource,
) {
  return {
    title: input.lesson.slice(0, 120),
    content: [
      `Model-proposed lesson: ${input.lesson}`,
      `Proposed applicability: ${input.applicability}`,
      `Invalid when: ${input.invalidation}`,
      `Repository: ${source.repository}`,
      `Baseline commit: ${source.baselineSha}`,
      `Candidate commit: ${source.candidateSha ?? "not frozen"}`,
      `Accepted evidence: ${input.evidenceRefs.join(", ")}`,
      `Evidence digest: ${source.evidenceDigest}`,
      "Host checks current PR delivery before insertion. This does not establish merge, release availability or semantic truth of the proposed lesson.",
    ].join("\n"),
  }
}

async function requireOwner(sessionID: string, caseId: string) {
  if (!(await OrynConfig.enabled())) throw storeError("NOT_AUTHORIZED", "oryn runtime is disabled")
  const binding = await OrynStore.sessionSourceBinding(sessionID)
  if (!binding || !["engineering", "worker"].includes(binding.role) || binding.caseId !== caseId) {
    throw storeError("NOT_AUTHORIZED", "only bound engineering or worker sessions may mutate Case learning")
  }
  const record = await OrynStore.getCase(caseId)
  if (!record) throw storeError("NOT_AUTHORIZED", "learning Case is unavailable")
  if (record.control !== "active") throw storeError("HUMAN_OWNED", `case is ${record.control}`, { caseId })
  await OrynBudget.assert(record)
  const session = await Session.get(sessionID)
  if (session.time.archived) throw storeError("NOT_AUTHORIZED", "learning session is archived")
  if (binding.role === "engineering") {
    if (record.engineeringSessionId !== sessionID || session.agentOverride !== "oryn-work") {
      throw storeError("NOT_AUTHORIZED", "caller is not the current engineering root")
    }
    return record
  }
  const assignment = (await OrynStore.listAssignments(caseId)).find((item) => item.sessionId === sessionID)
  if (
    !assignment ||
    assignment.epoch !== record.epoch ||
    assignment.attemptId !== record.activeAttemptId ||
    assignment.agentId !== session.agentOverride ||
    session.parentID !== record.engineeringSessionId
  )
    throw storeError("NOT_AUTHORIZED", "learning worker assignment is no longer current")
  return record
}

export namespace OrynLearning {
  /**
   * Proposals retain model-authored lesson text and references to Case
   * records. Record membership alone does not establish semantic truth.
   */
  export async function propose(input: {
    callerSessionID: string
    caseId: string
    lesson: string
    applicability: string
    invalidation: string
    evidenceRefs: string[]
  }): Promise<{ learningId: string; created: boolean }> {
    using _case = await Lock.write(`oryn-case:${input.caseId}`)
    const record = await requireOwner(input.callerSessionID, input.caseId)
    const evidenceRefs = [...new Set(input.evidenceRefs)].sort()
    const source = await learningSource(record, evidenceRefs)
    if (!source)
      throw storeError("EVIDENCE_INSUFFICIENT", "learning requires accepted evidence from the current Attempt", {
        caseId: record.id,
      })
    const memory = memoryText({ ...input, evidenceRefs }, source)
    const existing = (await OrynStore.listLearnings(record.id)).find(
      (item) =>
        JSON.stringify(item.source) === JSON.stringify(source) &&
        item.memory.title === memory.title &&
        item.memory.content === memory.content,
    )
    if (existing) return { learningId: existing.id, created: false }
    const candidate = await OrynStore.writeLearning({
      caseId: record.id,
      source,
      memory,
      lesson: input.lesson,
      applicability: input.applicability,
      invalidation: input.invalidation,
      evidenceRefs,
    })
    return { learningId: candidate.id, created: true }
  }

  /** Promotion requires current local delivery and a fresh remote observation. */
  export async function promoteCase(caseId: string): Promise<{ promoted: number; skipped: number }> {
    const oryn = await OrynConfig.info()
    if (!oryn?.enabled || oryn.learning?.verifiedMemory !== true) return { promoted: 0, skipped: 0 }
    const ready = await OrynReady.projection(caseId)
    if (!ready || !(await OrynReady.confirm(ready)))
      throw storeError("INVALID_STAGE", "promotion requires a current confirmed delivery", { caseId })
    const proofDigest = externalIdentityHash(JSON.stringify(ready))
    const writer = promoter
    if (!writer) return { promoted: 0, skipped: 0 }
    let promoted = 0
    let skipped = 0
    for (const listed of await OrynStore.listLearnings(caseId)) {
      using _lock = await Lock.write(`oryn-learning-effect:${listed.id}`)
      const candidate = await OrynStore.getLearning(listed.id)
      if (!candidate || candidate.promotionState !== "proposed") {
        skipped++
        continue
      }
      if (
        !candidate.source?.candidateSha ||
        JSON.stringify(candidate.source) !== JSON.stringify(await learningSource(ready.record, candidate.evidenceRefs))
      ) {
        skipped++
        continue
      }
      const input = memoryInput(candidate)
      let committed = false
      const memoryId = await writer.promote(input, async (write) => {
        if (committed) throw storeError("EVIDENCE_INSUFFICIENT", "memory writer attempted repeated commit")
        const proof = await OrynReady.projection(caseId)
        if (!proof || externalIdentityHash(JSON.stringify(proof)) !== proofDigest || !(await OrynReady.confirm(proof)))
          throw storeError("INVALID_STAGE", "delivery changed before memory promotion", { caseId })
        using _case = await Lock.write(`oryn-case:${caseId}`)
        const current = await OrynReady.projection(caseId)
        if (!current || externalIdentityHash(JSON.stringify(current)) !== proofDigest)
          throw storeError("INVALID_STAGE", "delivery changed before memory commit", { caseId })
        if (
          JSON.stringify(candidate.source) !==
          JSON.stringify(await learningSource(current.record, candidate.evidenceRefs))
        )
          throw storeError("EVIDENCE_INSUFFICIENT", "learning evidence changed before memory commit", { caseId })
        const id = write()
        if (id !== input.id)
          throw storeError("EVIDENCE_INSUFFICIENT", "memory writer returned a different learning identity")
        await OrynStore.mutateLearning(candidate.id, (d) => ({
          ...d,
          promotionState: "promoted" as const,
          memoryRef: id,
        }))
        committed = true
        return id
      })
      if (!committed || memoryId !== input.id)
        throw storeError("EVIDENCE_INSUFFICIENT", "memory writer did not complete the authorized commit")
      promoted++
    }
    return { promoted, skipped }
  }

  /**
   * Withdraw a lesson. A promoted candidate's shared memory is removed
   * through the injected port, so wrong knowledge does not linger after the
   * correction; the candidate itself is kept for the audit trail.
   */
  export async function invalidate(input: {
    callerSessionID: string
    caseId: string
    learningId: string
    reason: string
  }): Promise<LearningCandidate> {
    using _lock = await Lock.write(`oryn-learning-effect:${input.learningId}`)
    using _case = await Lock.write(`oryn-case:${input.caseId}`)
    await requireOwner(input.callerSessionID, input.caseId)
    const candidate = await OrynStore.getLearning(input.learningId)
    if (!candidate || candidate.caseId !== input.caseId) {
      throw storeError("NOT_AUTHORIZED", `learning candidate ${input.learningId} not found`)
    }
    if (candidate.promotionState === "rejected") return candidate
    if (!promoter) throw storeError("ENVIRONMENT_UNAVAILABLE", "memory writer is required to confirm lesson removal")
    const memory = memoryInput(candidate)
    await promoter.remove(memory.id, memory)
    return OrynStore.mutateLearning(input.learningId, (d) => ({
      ...d,
      promotionState: "rejected" as const,
      invalidation: `${d.invalidation} | withdrawn: ${input.reason}`,
    }))
  }
}
