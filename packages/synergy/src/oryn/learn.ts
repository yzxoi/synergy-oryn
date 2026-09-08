import { Lock } from "../util/lock"
import { externalIdentityHash } from "../util/identity"
import { OrynStore, storeError } from "./store"
import { OrynConfig } from "./config"
import { OrynBudget } from "./budget"
import { Session } from "../session"
import type { LearningCandidate } from "./schema"

/**
 * Injected verified-memory port. The Oryn domain never imports the Library
 * or the embedding runtime directly; product assembly wires the real
 * LibraryDB.Memory writer, and tests inject fakes. Reward automation is
 * intentionally absent: the upstream Experience reward API lacks event
 * idempotency, so `oryn.learning.autoReward` stays unimplemented by design.
 */
export type MemoryPromoter = {
  promote(input: { id: string; title: string; content: string }): Promise<string>
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
    title: candidate.lesson.slice(0, 120),
    content: [
      `Lesson: ${candidate.lesson}`,
      `Applies to: ${candidate.applicability}`,
      `Invalid when: ${candidate.invalidation}`,
      `Evidence (case-scoped records): ${candidate.evidenceRefs.join(", ")}`,
      `Verified at outcome version: ${candidate.outcomeVersion}`,
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
   * Worker/engineering proposal of a reusable lesson. Evidence refs are
   * host-validated against real case records (runs, reviews, reports,
   * attempts) — a lesson without case evidence is rejected, and raw chat
   * text never enters the candidate. Idempotent per identical lesson.
   */
  export async function propose(input: {
    callerSessionID: string
    caseId: string
    lesson: string
    applicability: string
    invalidation: string
    evidenceRefs: string[]
    outcomeVersion?: string
  }): Promise<{ learningId: string; created: boolean }> {
    using _case = await Lock.write(`oryn-case:${input.caseId}`)
    await requireOwner(input.callerSessionID, input.caseId)

    const valid = new Set<string>()
    for (const run of await OrynStore.listRuns(input.caseId)) valid.add(run.id)
    for (const review of await OrynStore.listReviews(input.caseId)) valid.add(review.id)
    for (const report of await OrynStore.listWorkerReports(input.caseId)) valid.add(report.id)
    for (const attempt of await OrynStore.listAttempts(input.caseId)) valid.add(attempt.id)
    const unknown = input.evidenceRefs.filter((ref) => !valid.has(ref))
    if (unknown.length > 0) {
      throw storeError("EVIDENCE_INSUFFICIENT", `evidence refs are not records of this case: ${unknown.join(", ")}`, {
        caseId: input.caseId,
      })
    }

    const existing = (await OrynStore.listLearnings(input.caseId)).find((l) => l.lesson === input.lesson)
    if (existing) return { learningId: existing.id, created: false }
    const candidate = await OrynStore.writeLearning({
      caseId: input.caseId,
      outcomeVersion: input.outcomeVersion ?? "1",
      lesson: input.lesson,
      applicability: input.applicability,
      invalidation: input.invalidation,
      evidenceRefs: input.evidenceRefs,
    })
    return { learningId: candidate.id, created: true }
  }

  /**
   * Host promotion after a case reaches a delivered attempt. Gated by
   * `oryn.learning.verifiedMemory` (default false), so a deployment must
   * explicitly opt in before anything reaches shared memory. Candidates
   * carry their own invalidation condition and case-scoped evidence, and a
   * merged-but-unreleased fix never reads as generally available because
   * the memory text states the outcome version it was verified at.
   */
  export async function promoteCase(caseId: string): Promise<{ promoted: number; skipped: number }> {
    const oryn = await OrynConfig.info()
    if (!oryn?.enabled || oryn.learning?.verifiedMemory !== true) return { promoted: 0, skipped: 0 }
    const ready = (await OrynStore.listAttempts(caseId)).find((a) => a.disposition === "ready")
    if (!ready) {
      throw storeError("INVALID_STAGE", "promotion requires a delivered (ready) attempt", { caseId })
    }
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
      const input = memoryInput(candidate)
      const memoryId = await writer.promote(input)
      if (memoryId !== input.id)
        throw storeError("EVIDENCE_INSUFFICIENT", "memory writer returned a different learning identity")
      await OrynStore.mutateLearning(candidate.id, (d) => ({
        ...d,
        promotionState: "promoted" as const,
        memoryRef: memoryId,
      }))
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
