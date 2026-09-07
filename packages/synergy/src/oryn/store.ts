import { Identifier } from "../id/id"
import { externalIdentityHash } from "../util/identity"
import { Lock } from "../util/lock"
import { Storage } from "../storage/storage"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import z from "zod"
import { OrynPath } from "./path"
import { RunReceipt, ReviewReport } from "./schema"
import type {
  ActionReceipt,
  Attempt,
  Assignment,
  Case,
  CaseControl,
  IntakeClaim,
  LearningCandidate,
  SourceIdentity,
  SourceLink,
} from "./schema"

export const OrynStoreError = NamedError.create(
  "OrynStoreError",
  z.object({
    code: z.enum([
      "NOT_AUTHORIZED",
      "STALE_REVISION",
      "STALE_HEAD",
      "INVALID_STAGE",
      "ENVIRONMENT_UNAVAILABLE",
      "BUDGET_EXHAUSTED",
      "HUMAN_OWNED",
      "EVIDENCE_INSUFFICIENT",
      "REMOTE_AMBIGUOUS",
    ]),
    message: z.string(),
    caseId: z.string().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  }),
)

export type OrynStoreErrorCode =
  | "NOT_AUTHORIZED"
  | "STALE_REVISION"
  | "STALE_HEAD"
  | "INVALID_STAGE"
  | "ENVIRONMENT_UNAVAILABLE"
  | "BUDGET_EXHAUSTED"
  | "HUMAN_OWNED"
  | "EVIDENCE_INSUFFICIENT"
  | "REMOTE_AMBIGUOUS"

export type OrynStoreErrorInstance = InstanceType<typeof OrynStoreError>

export function storeError(
  code: OrynStoreErrorCode,
  message: string,
  extra?: { caseId?: string; expectedRevision?: number },
): OrynStoreErrorInstance {
  return new OrynStoreError({ code, message, ...extra })
}

/**
 * Normalize a source identity into a stable dedup key. Field order is fixed
 * so the same logical source always maps to the same key; raw identity
 * strings are stored only inside the SourceLink record, never as path
 * segments.
 */
export function sourceKey(identity: SourceIdentity): string {
  const parts = [
    identity.provider,
    identity.accountId,
    identity.chatId ?? "",
    identity.threadId ?? "",
    identity.provider === "github"
      ? String(identity.issueNumber ?? identity.messageId ?? "")
      : (identity.messageId ?? ""),
  ]
  return externalIdentityHash(...parts)
}

function now(): number {
  return Date.now()
}

export namespace OrynStore {
  /**
   * Claim a source for intake. Idempotent on the normalized source key: the
   * first caller fixes the caseId and later concurrent or replayed submits
   * observe the existing claim instead of creating a second case. The
   * normalized-key lock closes the read-then-write race.
   */
  export async function claimSource(input: {
    identity: SourceIdentity
    requestKey: string
    caseId?: string
  }): Promise<{ claim: IntakeClaim; created: boolean }> {
    const key = sourceKey(input.identity)
    using _lock = await Lock.write(`oryn-claim:${key}`)
    const existing = await Storage.read<IntakeClaim>(OrynPath.claim(key)).catch(() => undefined)
    if (existing) return { claim: existing, created: false }
    const claim: IntakeClaim = {
      schemaVersion: 1,
      sourceKey: key,
      caseId: input.caseId ?? Identifier.ascending("oryn_case"),
      requestKey: input.requestKey,
      state: "claimed",
      createdAt: now(),
      updatedAt: now(),
    }
    await Storage.write(OrynPath.claim(key), claim)
    return { claim, created: true }
  }

  export async function getClaim(sourceKeyHash: string): Promise<IntakeClaim | undefined> {
    return Storage.read<IntakeClaim>(OrynPath.claim(sourceKeyHash)).catch(() => undefined)
  }

  export async function updateClaim(sourceKeyHash: string, patch: Partial<IntakeClaim>): Promise<IntakeClaim> {
    using _lock = await Lock.write(`oryn-claim:${sourceKeyHash}`)
    const current = await getClaim(sourceKeyHash)
    if (!current) throw storeError("NOT_AUTHORIZED", `no claim for source key ${sourceKeyHash}`)
    const next: IntakeClaim = { ...current, ...patch, updatedAt: now() }
    await Storage.write(OrynPath.claim(sourceKeyHash), next)
    return next
  }

  /** Claims that never reached a terminal state; the restart recovery input. */
  export async function incompleteClaims(): Promise<IntakeClaim[]> {
    const keys = await Storage.scan(OrynPath.claimsRoot())
    const claims = await Promise.all(keys.map((key) => getClaim(key)))
    return claims.filter((c): c is IntakeClaim => c !== undefined && c.state !== "completed" && c.state !== "failed")
  }

  export async function recordSource(input: {
    identity: SourceIdentity
    reporter?: string
    qaScopeId?: string
  }): Promise<SourceLink> {
    const key = sourceKey(input.identity)
    const existing = await Storage.read<SourceLink>(OrynPath.source(key)).catch(() => undefined)
    if (existing) return existing
    const link: SourceLink = {
      schemaVersion: 1,
      id: `src_${key.slice(0, 16)}`,
      key,
      identity: input.identity,
      reporter: input.reporter,
      qaSessionId: input.qaScopeId,
      visibility: "private",
      caseIds: [],
      createdAt: now(),
    }
    await Storage.write(OrynPath.source(key), link)
    return link
  }

  export async function getSource(sourceKeyHash: string): Promise<SourceLink | undefined> {
    return Storage.read<SourceLink>(OrynPath.source(sourceKeyHash)).catch(() => undefined)
  }

  /** Link a source to a case. Append-only: shared sources gain subscribers. */
  export async function linkSourceToCase(sourceKeyHash: string, caseId: string): Promise<SourceLink> {
    using _lock = await Lock.write(`oryn-claim:${sourceKeyHash}`)
    const link = await getSource(sourceKeyHash)
    if (!link) throw storeError("NOT_AUTHORIZED", `source ${sourceKeyHash} not recorded`)
    if (!link.caseIds.includes(caseId)) {
      const next = { ...link, caseIds: [...link.caseIds, caseId] }
      await Storage.write(OrynPath.source(sourceKeyHash), next)
    }
    const record = await getCase(caseId)
    if (!record) throw storeError("NOT_AUTHORIZED", `case ${caseId} missing while linking source`)
    if (!record.sourceIds.includes(sourceKeyHash)) {
      await writeCase({ ...record, sourceIds: [...record.sourceIds, sourceKeyHash], updatedAt: now() })
    }
    const updated = await getSource(sourceKeyHash)
    return updated!
  }

  export async function getCase(caseId: string): Promise<Case | undefined> {
    return Storage.read<Case>(OrynPath.caseInfo(caseId)).catch(() => undefined)
  }

  /** Source-bound read: the caller source must already be linked to the case. */
  export async function getCaseForSource(caseId: string, sourceKeyHash: string): Promise<Case> {
    const record = await getCase(caseId)
    if (!record) throw storeError("NOT_AUTHORIZED", `case ${caseId} not found`)
    if (!record.sourceIds.includes(sourceKeyHash))
      throw storeError("NOT_AUTHORIZED", `source is not linked to case ${caseId}`)
    return record
  }

  async function writeCase(record: Case): Promise<void> {
    await Storage.write(OrynPath.caseInfo(record.id), record)
    const indexScope = Identifier.asScopeID(record.qaScopeId ?? record.workScopeId ?? "global")
    await Storage.write(OrynPath.caseIndexEntry(indexScope, record.id), {
      caseId: record.id,
      updatedAt: record.updatedAt,
    })
  }

  export async function createCase(input: {
    caseId: string
    kind: Case["kind"]
    summary: string
    observed?: string
    expected?: string
    repoAlias: string
    sourceKeyHash: string
    qaScopeId?: string
  }): Promise<Case> {
    using _lock = await Lock.write(`oryn-case:${input.caseId}`)
    const existing = await getCase(input.caseId)
    if (existing) return existing
    const ts = now()
    const record: Case = {
      schemaVersion: 1,
      id: input.caseId,
      revision: 0,
      kind: input.kind,
      summary: input.summary,
      observed: input.observed,
      expected: input.expected,
      repoAlias: input.repoAlias,
      sourceIds: [input.sourceKeyHash],
      pullNumbers: [],
      qaScopeId: input.qaScopeId,
      control: "active",
      acceptanceDigest: externalIdentityHash(input.expected ?? input.summary),
      acceptanceRevision: 0,
      epoch: 0,
      repairRounds: 0,
      noProgressRounds: 0,
      humanDecisions: [],
      createdAt: ts,
      updatedAt: ts,
    }
    await writeCase(record)
    return record
  }

  /**
   * Compare-and-set case mutation. The caller closure receives the current
   * record only after the revision check passes; its result is written with
   * revision+1 under the case lock.
   */
  export async function mutateCase(
    caseId: string,
    expectedRevision: number,
    mutate: (draft: Case) => Case | Promise<Case>,
  ): Promise<Case> {
    using _lock = await Lock.write(`oryn-case:${caseId}`)
    const current = await getCase(caseId)
    if (!current) throw storeError("NOT_AUTHORIZED", `case ${caseId} not found`)
    if (current.revision !== expectedRevision) {
      throw storeError("STALE_REVISION", "case revision changed", { caseId, expectedRevision })
    }
    const next = await mutate(current)
    const record: Case = { ...next, revision: current.revision + 1, updatedAt: now() }
    await writeCase(record)
    return record
  }

  export async function listCases(filter: { repoAlias?: string; control?: CaseControl } = {}): Promise<Case[]> {
    const ids = await Storage.scan(OrynPath.casesRoot())
    const records = await Promise.all(ids.map((id) => Storage.read<Case>(OrynPath.caseInfo(id)).catch(() => undefined)))
    return records
      .filter((r): r is Case => r !== undefined)
      .filter((r) => (filter.repoAlias ? r.repoAlias === filter.repoAlias : true))
      .filter((r) => (filter.control ? r.control === filter.control : true))
  }

  /** Human control transition. takeover/cancel bump the epoch, invalidating pending external actions. */
  export async function control(
    caseId: string,
    expectedRevision: number,
    action: "pause" | "resume" | "takeover" | "cancel",
  ): Promise<Case> {
    return mutateCase(caseId, expectedRevision, (record) => {
      if (record.control === "closed") throw storeError("HUMAN_OWNED", "case is closed", { caseId })
      const nextControl: CaseControl =
        action === "pause"
          ? "paused"
          : action === "resume"
            ? "active"
            : action === "takeover"
              ? "human_owned"
              : "cancelled"
      return {
        ...record,
        control: nextControl,
        epoch: action === "takeover" || action === "cancel" ? record.epoch + 1 : record.epoch,
      }
    })
  }

  /**
   * Acceptance amendment rotates the digest so in-flight delivery cannot ride
   * on stale verification input; callers decide Attempt rotation separately.
   */
  export async function amendAcceptance(
    caseId: string,
    expectedRevision: number,
    patch: { observed?: string; expected?: string },
  ): Promise<Case> {
    return mutateCase(caseId, expectedRevision, (record) => ({
      ...record,
      observed: patch.observed ?? record.observed,
      expected: patch.expected ?? record.expected,
      acceptanceDigest: externalIdentityHash(patch.expected ?? record.expected ?? record.summary),
      acceptanceRevision: record.acceptanceRevision + 1,
    }))
  }

  export async function createAttempt(input: {
    caseId: string
    baselineSha: string
    baseBranchSha?: string
  }): Promise<Attempt> {
    const ts = now()
    const attempt: Attempt = {
      schemaVersion: 1,
      id: Identifier.ascending("oryn_attempt"),
      caseId: input.caseId,
      revision: 0,
      baselineSha: input.baselineSha,
      baseBranchSha: input.baseBranchSha,
      assignmentIds: [],
      evidenceRunIds: [],
      reviewIds: [],
      disposition: "open",
      createdAt: ts,
      updatedAt: ts,
    }
    await Storage.write(OrynPath.attempt(input.caseId, attempt.id), attempt)
    return attempt
  }

  export async function getAttempt(caseId: string, attemptId: string): Promise<Attempt | undefined> {
    return Storage.read<Attempt>(OrynPath.attempt(caseId, attemptId)).catch(() => undefined)
  }

  export async function mutateAttempt(
    caseId: string,
    attemptId: string,
    mutate: (draft: Attempt) => Attempt,
  ): Promise<Attempt> {
    using _lock = await Lock.write(`oryn-attempt:${caseId}:${attemptId}`)
    const current = await getAttempt(caseId, attemptId)
    if (!current) throw storeError("NOT_AUTHORIZED", `attempt ${attemptId} not found`)
    const next = { ...mutate(current), revision: current.revision + 1, updatedAt: now() }
    await Storage.write(OrynPath.attempt(caseId, attemptId), next)
    return next
  }

  export async function setActiveAttempt(caseId: string, expectedRevision: number, attemptId: string): Promise<Case> {
    return mutateCase(caseId, expectedRevision, (record) => ({ ...record, activeAttemptId: attemptId }))
  }

  export async function createAssignment(input: {
    caseId: string
    attemptId: string
    stage: Assignment["stage"]
    agentId: string
    frozenInputsDigest: string
    epoch: number
    reviewDomain?: Assignment["reviewDomain"]
    sessionId?: string
    requestKey?: string
  }): Promise<Assignment> {
    const ts = now()
    const assignment: Assignment = {
      schemaVersion: 1,
      id: Identifier.ascending("oryn_assignment"),
      caseId: input.caseId,
      attemptId: input.attemptId,
      stage: input.stage,
      agentId: input.agentId,
      sessionId: input.sessionId,
      frozenInputsDigest: input.frozenInputsDigest,
      requestKey: input.requestKey ?? `req_${Identifier.short("oryn_assignment")}`,
      epoch: input.epoch,
      reviewDomain: input.reviewDomain,
      createdAt: ts,
      updatedAt: ts,
    }
    await Storage.write(OrynPath.assignment(input.caseId, assignment.id), assignment)
    await mutateAttempt(input.caseId, input.attemptId, (draft) => ({
      ...draft,
      assignmentIds: [...draft.assignmentIds, assignment.id],
    }))
    return assignment
  }

  export async function getAssignment(caseId: string, assignmentId: string): Promise<Assignment | undefined> {
    return Storage.read<Assignment>(OrynPath.assignment(caseId, assignmentId)).catch(() => undefined)
  }

  /** Dedup target for repeated dispatch requestKeys on the same attempt. */
  export async function findAssignmentByRequestKey(
    caseId: string,
    attemptId: string,
    requestKey: string,
  ): Promise<Assignment | undefined> {
    const ids = await Storage.scan(OrynPath.assignmentsRoot(caseId))
    const records = await Promise.all(ids.map((id) => getAssignment(caseId, id)))
    return records.find((r) => r !== undefined && r.attemptId === attemptId && r.requestKey === requestKey)
  }

  /** Trusted executor writes run receipts; workers reference them read-only. */
  export async function writeRunReceipt(
    receipt: Omit<z.input<typeof RunReceipt>, "id" | "schemaVersion">,
  ): Promise<RunReceipt> {
    const record = RunReceipt.parse({ schemaVersion: 1, id: Identifier.ascending("oryn_run"), ...receipt })
    await Storage.write(OrynPath.run(record.caseId, record.id), record)
    return record
  }

  export async function getRun(caseId: string, runId: string): Promise<RunReceipt | undefined> {
    return Storage.read<RunReceipt>(OrynPath.run(caseId, runId)).catch(() => undefined)
  }

  export async function writeReview(
    report: Omit<z.input<typeof ReviewReport>, "id" | "schemaVersion" | "createdAt">,
  ): Promise<ReviewReport> {
    const record = ReviewReport.parse({
      schemaVersion: 1,
      id: Identifier.ascending("oryn_review"),
      createdAt: now(),
      ...report,
    })
    await Storage.write(OrynPath.review(record.caseId, record.id), record)
    await mutateAttempt(record.caseId, record.attemptId, (draft) => ({
      ...draft,
      reviewIds: draft.reviewIds.includes(record.id) ? draft.reviewIds : [...draft.reviewIds, record.id],
    }))
    return record
  }

  export async function getReview(caseId: string, reviewId: string): Promise<ReviewReport | undefined> {
    return Storage.read<ReviewReport>(OrynPath.review(caseId, reviewId)).catch(() => undefined)
  }

  export async function writeAction(
    input: Omit<ActionReceipt, "schemaVersion" | "id" | "createdAt" | "updatedAt" | "attempts">,
  ): Promise<ActionReceipt> {
    const ts = now()
    const record: ActionReceipt = {
      schemaVersion: 1,
      id: Identifier.ascending("oryn_action"),
      attempts: 0,
      ...input,
      createdAt: ts,
      updatedAt: ts,
    }
    await Storage.write(OrynPath.action(record.id), record)
    return record
  }

  export async function getAction(actionId: string): Promise<ActionReceipt | undefined> {
    return Storage.read<ActionReceipt>(OrynPath.action(actionId)).catch(() => undefined)
  }

  export async function mutateAction(
    actionId: string,
    mutate: (draft: ActionReceipt) => ActionReceipt,
  ): Promise<ActionReceipt> {
    using _lock = await Lock.write(`oryn-action:${actionId}`)
    const current = await getAction(actionId)
    if (!current) throw storeError("NOT_AUTHORIZED", `action ${actionId} not found`)
    const next = { ...mutate(current), updatedAt: now() }
    await Storage.write(OrynPath.action(actionId), next)
    return next
  }

  export async function writeLearning(input: {
    caseId: string
    outcomeVersion: string
    lesson: string
    applicability: string
    invalidation: string
    evidenceRefs: string[]
  }): Promise<LearningCandidate> {
    const ts = now()
    const record: LearningCandidate = {
      schemaVersion: 1,
      id: Identifier.ascending("oryn_learning"),
      caseId: input.caseId,
      outcomeVersion: input.outcomeVersion,
      lesson: input.lesson,
      applicability: input.applicability,
      invalidation: input.invalidation,
      evidenceRefs: input.evidenceRefs,
      promotionState: "proposed",
      createdAt: ts,
      updatedAt: ts,
    }
    await Storage.write(OrynPath.learning(record.id), record)
    return record
  }

  export async function getLearning(candidateId: string): Promise<LearningCandidate | undefined> {
    return Storage.read<LearningCandidate>(OrynPath.learning(candidateId)).catch(() => undefined)
  }

  export async function mutateLearning(
    candidateId: string,
    mutate: (draft: LearningCandidate) => LearningCandidate,
  ): Promise<LearningCandidate> {
    using _lock = await Lock.write(`oryn-learning:${candidateId}`)
    const current = await getLearning(candidateId)
    if (!current) throw storeError("NOT_AUTHORIZED", `learning candidate ${candidateId} not found`)
    const next = { ...mutate(current), updatedAt: now() }
    await Storage.write(OrynPath.learning(candidateId), next)
    return next
  }
}
