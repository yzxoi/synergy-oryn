import { Identifier } from "../id/id"
import { externalIdentityHash } from "../util/identity"
import { Lock } from "../util/lock"
import { Storage } from "../storage/storage"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import z from "zod"
import { OrynPath } from "./path"
import {
  Attempt,
  AttemptTransition,
  ChannelSource,
  LearningCandidate,
  OutboxEntry,
  RunReceipt,
  ReviewReport,
  WorkerReport,
} from "./schema"
import type { CheckPlan } from "./schema"
import type {
  ActionReceipt,
  Assignment,
  Case,
  CaseControl,
  IntakeClaim,
  OutboxEntry as OutboxEntryT,
  SourceIdentity,
  SourceLink,
  WorkerReport as WorkerReportT,
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
   * Claim a source for intake. Idempotent per (source, requestKey): replayed
   * submissions of the same event observe the existing claim instead of
   * creating a second case, while a new requestKey from the same topic opens
   * a new case (one topic may hold many cases). The per-key lock closes the
   * read-then-write race.
   */
  export async function claimSource(input: {
    identity: SourceIdentity
    requestKey: string
    caseId?: string
  }): Promise<{ claim: IntakeClaim; created: boolean }> {
    const key = sourceKey(input.identity)
    const requestKeyHash = externalIdentityHash(input.requestKey)
    using _lock = await Lock.write(`oryn-claim:${key}:${requestKeyHash}`)
    const existing = await Storage.read<IntakeClaim>(OrynPath.claim(key, requestKeyHash)).catch(() => undefined)
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
    await Storage.write(OrynPath.claim(key, requestKeyHash), claim)
    return { claim, created: true }
  }

  export async function getClaim(sourceKeyHash: string, requestKey: string): Promise<IntakeClaim | undefined> {
    return Storage.read<IntakeClaim>(OrynPath.claim(sourceKeyHash, externalIdentityHash(requestKey))).catch(
      () => undefined,
    )
  }

  export async function updateClaim(
    sourceKeyHash: string,
    requestKey: string,
    patch: Partial<IntakeClaim>,
  ): Promise<IntakeClaim> {
    const requestKeyHash = externalIdentityHash(requestKey)
    using _lock = await Lock.write(`oryn-claim:${sourceKeyHash}:${requestKeyHash}`)
    const current = await getClaim(sourceKeyHash, requestKey)
    if (!current) throw storeError("NOT_AUTHORIZED", `no claim for source key ${sourceKeyHash}`)
    const next: IntakeClaim = { ...current, ...patch, updatedAt: now() }
    await Storage.write(OrynPath.claim(sourceKeyHash, requestKeyHash), next)
    return next
  }

  /** Claims that never reached a terminal state; the restart recovery input. */
  export async function incompleteClaims(): Promise<IntakeClaim[]> {
    const sourceKeys = await Storage.scan(OrynPath.claimsRoot())
    const claims = await Promise.all(
      sourceKeys.flatMap(async (sourceKeyHash) => {
        const requestKeys = await Storage.scan([...OrynPath.claimsRoot(), sourceKeyHash])
        return Promise.all(
          requestKeys.map((requestKeyHash) =>
            Storage.read<IntakeClaim>(OrynPath.claim(sourceKeyHash, requestKeyHash)).catch(() => undefined),
          ),
        )
      }),
    )
    return claims
      .flat()
      .filter((c): c is IntakeClaim => c !== undefined && c.state !== "completed" && c.state !== "failed")
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

  function matchesConversation(binding: SessionSourceBinding, source: ChannelSource, sessionID: string): boolean {
    return (
      binding.role === "qa" &&
      source.qaSessionId === sessionID &&
      binding.identity?.provider === source.identity.provider &&
      binding.identity.accountId === source.identity.accountId &&
      binding.identity.chatId === source.identity.chatId &&
      binding.identity.threadId === source.identity.threadId
    )
  }

  export async function qaTurnSource(sessionID: string, turnID?: string): Promise<SourceIdentity> {
    const binding = await sessionSourceBinding(sessionID)
    if (!binding || binding.role !== "qa" || !binding.identity) {
      throw storeError("NOT_AUTHORIZED", "session has no QA source binding")
    }
    if (!turnID) {
      if (await channelSource(binding.sourceKey)) {
        throw storeError("NOT_AUTHORIZED", "Channel operation requires its durable root turn")
      }
      return binding.identity
    }
    const turn = await channelTurn(sessionID, turnID)
    if (!turn || !matchesConversation(binding, turn, sessionID)) {
      throw storeError("NOT_AUTHORIZED", "root turn does not belong to this QA source")
    }
    return turn.identity
  }

  async function sessionOwnsSource(sessionID: string, binding: SessionSourceBinding, key: string): Promise<boolean> {
    if (binding.sourceKey === key) return true
    const source = await channelSource(key)
    return source !== undefined && matchesConversation(binding, source, sessionID)
  }

  export async function getCaseForSession(caseId: string, sessionID: string): Promise<Case> {
    const binding = await sessionSourceBinding(sessionID)
    const record = await getCase(caseId)
    if (
      !binding ||
      !record ||
      !["qa", "engineering", "worker"].includes(binding.role) ||
      (binding.role !== "qa" && binding.caseId !== caseId)
    ) {
      throw storeError("NOT_AUTHORIZED", "case does not belong to this session")
    }
    for (const key of record.sourceIds) {
      if (await sessionOwnsSource(sessionID, binding, key)) return record
    }
    throw storeError("NOT_AUTHORIZED", "case has no source owned by this session")
  }

  export async function listCasesForSession(sessionID: string): Promise<Case[]> {
    const binding = await sessionSourceBinding(sessionID)
    if (!binding || binding.role !== "qa") throw storeError("NOT_AUTHORIZED", "session has no QA source binding")
    const keys = new Set([binding.sourceKey])
    for (const rootID of await Storage.scan(OrynPath.channelTurnsRoot(sessionID))) {
      const turn = await channelTurn(sessionID, rootID)
      if (turn && matchesConversation(binding, turn, sessionID)) keys.add(sourceKey(turn.identity))
    }
    const records = new Map<string, Case>()
    for (const key of keys) {
      for (const record of await listCasesForSource(key)) {
        if (record.sourceIds.includes(key)) records.set(record.id, record)
      }
    }
    return [...records.values()]
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
      schemaVersion: 2,
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
    using _lock = await Lock.write(`oryn-case:${caseId}`)
    const record = await getCase(caseId)
    if (!record) throw storeError("NOT_AUTHORIZED", "Case not found")
    if (record.revision !== expectedRevision)
      throw storeError("STALE_REVISION", "Case revision changed", { caseId, expectedRevision })
    if (record.control === "closed") throw storeError("HUMAN_OWNED", "case is closed", { caseId })
    if (action === "pause" && ["human_owned", "cancelled"].includes(record.control))
      throw storeError("HUMAN_OWNED", "Resume ownership explicitly before pausing automation")
    if (action === "resume" && record.activeAttemptId && ["human_owned", "cancelled"].includes(record.control)) {
      const previous = await getAttempt(caseId, record.activeAttemptId)
      if (!previous) throw storeError("INVALID_STAGE", "Ownership resume is missing its previous Attempt")
      return (
        await applyAttemptTransition(
          {
            caseId,
            fromAttemptId: previous.id,
            invalidationReason: "Human requested a new ownership attempt",
            nextBaselineSha: previous.candidateSha ?? previous.baselineSha,
            countRepair: false,
            countNoProgress: false,
          },
          "resume",
          record,
        )
      ).case
    }
    const nextControl: CaseControl =
      action === "pause"
        ? "paused"
        : action === "resume"
          ? "active"
          : action === "takeover"
            ? "human_owned"
            : "cancelled"
    const updated = {
      ...record,
      revision: record.revision + 1,
      control: nextControl,
      epoch: action === "takeover" || action === "cancel" ? record.epoch + 1 : record.epoch,
      updatedAt: now(),
    }
    await writeCase(updated)
    return updated
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
    await linkAssignment(assignment)
    return assignment
  }

  export async function linkAssignment(assignment: Assignment): Promise<void> {
    using _lock = await Lock.write(`oryn-attempt:${assignment.caseId}:${assignment.attemptId}`)
    const attempt = await getAttempt(assignment.caseId, assignment.attemptId)
    if (!attempt) throw storeError("INVALID_STAGE", "assignment Attempt is unavailable")
    if (attempt.assignmentIds.includes(assignment.id)) return
    await Storage.write(OrynPath.attempt(assignment.caseId, assignment.attemptId), {
      ...attempt,
      assignmentIds: [...attempt.assignmentIds, assignment.id],
      revision: attempt.revision + 1,
      updatedAt: now(),
    })
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
    requestKey?: string,
  ): Promise<ReviewReport> {
    const id = requestKey
      ? `orv_${externalIdentityHash(report.caseId, report.assignmentId, requestKey)}`
      : Identifier.ascending("oryn_review")
    using _lock = await Lock.write(`oryn-review-request:${id}`)
    const payloadSchema = ReviewReport.omit({ id: true, schemaVersion: true, createdAt: true })
    const payload = payloadSchema.parse(report)
    let existing: ReviewReport | undefined
    try {
      existing = ReviewReport.parse(await Storage.read(OrynPath.review(report.caseId, id)))
    } catch (error) {
      if (!(error instanceof Storage.NotFoundError)) throw error
    }
    if (existing) {
      const { id: _id, schemaVersion: _version, createdAt: _createdAt, ...previous } = existing
      if (JSON.stringify(payloadSchema.parse(previous)) !== JSON.stringify(payload)) {
        throw storeError("INVALID_STAGE", "review request key was already used with different content")
      }
    }
    const record =
      existing ??
      ReviewReport.parse({
        schemaVersion: 1,
        id,
        createdAt: now(),
        ...report,
      })
    if (!existing) await Storage.write(OrynPath.review(record.caseId, record.id), record)
    if (!(await getAttempt(record.caseId, record.attemptId))?.reviewIds.includes(record.id)) {
      await mutateAttempt(record.caseId, record.attemptId, (draft) => ({
        ...draft,
        reviewIds: draft.reviewIds.includes(record.id) ? draft.reviewIds : [...draft.reviewIds, record.id],
      }))
    }
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
      schemaVersion: 4,
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

  export async function listActions(filter: { caseId?: string } = {}): Promise<ActionReceipt[]> {
    const ids = await Storage.scan(OrynPath.actionsRoot())
    const records = await Promise.all(
      ids.map((id) => Storage.read<ActionReceipt>(OrynPath.action(id)).catch(() => undefined)),
    )
    return records
      .filter((r): r is ActionReceipt => r !== undefined)
      .filter((r) => (filter.caseId ? r.caseId === filter.caseId : true))
  }

  /** requestKey idempotency for external actions: replays return the existing receipt. */
  export async function findActionByRequestKey(caseId: string, requestKey: string): Promise<ActionReceipt | undefined> {
    const actions = await listActions({ caseId })
    return actions.find((a) => a.requestKey === requestKey)
  }

  export async function writeLearning(
    input: Pick<
      LearningCandidate,
      "caseId" | "source" | "memory" | "lesson" | "applicability" | "invalidation" | "evidenceRefs"
    >,
  ): Promise<LearningCandidate> {
    const ts = now()
    const record = LearningCandidate.parse({
      ...input,
      schemaVersion: 2,
      id: Identifier.ascending("oryn_learning"),
      promotionState: "proposed",
      createdAt: ts,
      updatedAt: ts,
    })
    await Storage.write(OrynPath.learning(record.id), record)
    return record
  }

  export async function getLearning(candidateId: string): Promise<LearningCandidate | undefined> {
    const value = await Storage.read<unknown>(OrynPath.learning(candidateId)).catch((error: unknown) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
    return value === undefined ? undefined : LearningCandidate.parse(value)
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

  /** Learning candidates for one case, oldest first. */
  export async function listLearnings(caseId: string): Promise<LearningCandidate[]> {
    const ids = await Storage.scan(OrynPath.learningRoot())
    const records = await Promise.all(ids.map((id) => getLearning(id)))
    return records
      .filter((r): r is LearningCandidate => r !== undefined && r.caseId === caseId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Host-side binding written when a QA/engineering/worker session is created for a source. */
  export async function bindSessionSource(input: {
    sessionID: string
    identity: SourceIdentity
    caseId?: string
    role: "qa" | "engineering" | "worker"
  }): Promise<void> {
    await Storage.write(OrynPath.sessionSource(input.sessionID), {
      sourceKey: sourceKey(input.identity),
      identity: input.identity,
      caseId: input.caseId,
      role: input.role,
      boundAt: now(),
    })
  }

  export type SessionSourceBinding = {
    sourceKey: string
    identity?: SourceIdentity
    caseId?: string
    role: string
    boundAt: number
  }

  export async function sessionSourceBinding(sessionID: string): Promise<SessionSourceBinding | undefined> {
    return Storage.read<SessionSourceBinding>(OrynPath.sessionSource(sessionID)).catch(() => undefined)
  }

  export async function recordChannelTurn(input: {
    sessionID: string
    rootID: string
    identity: SourceIdentity
    chatType: "dm" | "group"
    scopeKey?: string
  }): Promise<void> {
    const source = ChannelSource.parse({
      schemaVersion: 1,
      qaSessionId: input.sessionID,
      identity: input.identity,
      chatType: input.chatType,
      scopeKey: input.scopeKey,
    })
    const link = await recordSource({ identity: input.identity })
    await Storage.write(OrynPath.channelSource(link.key), source)
    await Storage.write(OrynPath.channelTurn(input.sessionID, input.rootID), { sourceKey: link.key })
  }

  export async function channelSource(sourceKeyHash: string): Promise<ChannelSource | undefined> {
    const record = await Storage.read<unknown>(OrynPath.channelSource(sourceKeyHash)).catch(() => undefined)
    return record === undefined ? undefined : ChannelSource.parse(record)
  }

  export async function channelTurn(sessionID: string, rootID: string): Promise<ChannelSource | undefined> {
    const turn = await Storage.read<{ sourceKey: string }>(OrynPath.channelTurn(sessionID, rootID)).catch(
      () => undefined,
    )
    return turn ? channelSource(turn.sourceKey) : undefined
  }

  /** Workers append structured reports; the host validates identity before accepting. */
  export async function writeWorkerReport(
    input: Omit<z.input<typeof WorkerReport>, "id" | "schemaVersion" | "createdAt">,
  ): Promise<WorkerReportT> {
    using _lock = await Lock.write(
      `oryn-report-request:${externalIdentityHash(input.caseId, input.assignmentId, input.requestKey)}`,
    )
    const payloadSchema = WorkerReport.omit({ id: true, schemaVersion: true, createdAt: true })
    const payload = payloadSchema.parse(input)
    const existing = (await listWorkerReports(input.caseId)).find(
      (report) => report.assignmentId === input.assignmentId && report.requestKey === input.requestKey,
    )
    if (existing) {
      const { id: _id, schemaVersion: _version, createdAt: _createdAt, ...existingPayload } = existing
      if (JSON.stringify(payloadSchema.parse(existingPayload)) !== JSON.stringify(payload)) {
        throw storeError("INVALID_STAGE", "result request key was already used with different content")
      }
      return existing
    }
    const record = WorkerReport.parse({
      schemaVersion: 1,
      id: Identifier.ascending("oryn_run"),
      createdAt: now(),
      ...input,
    })
    await Storage.write(OrynPath.report(record.caseId, record.id), record)
    return record
  }

  export async function getWorkerReport(caseId: string, reportId: string): Promise<WorkerReportT | undefined> {
    return Storage.read<WorkerReportT>(OrynPath.report(caseId, reportId)).catch(() => undefined)
  }

  export async function listWorkerReports(caseId: string): Promise<WorkerReportT[]> {
    const ids = await Storage.scan(OrynPath.reportsRoot(caseId))
    const records = await Promise.all(ids.map((id) => getWorkerReport(caseId, id)))
    return records.filter((r): r is WorkerReportT => r !== undefined)
  }

  /**
   * Durable delivery intent written by oryn_reply. Deduped on dedupKey so
   * repeated ready notifications or retries cannot double-deliver; the
   * channel outbox drain marks entries delivered or suppressed.
   */
  export async function writeOutbox(input: {
    caseId?: string
    sourceKeyHash: string
    kind: OutboxEntryT["kind"]
    text: string
    dedupKey: string
  }): Promise<{ entry: OutboxEntryT; created: boolean }> {
    using _lock = await Lock.write(`oryn-outbox-dedup:${externalIdentityHash(input.sourceKeyHash, input.dedupKey)}`)
    const ids = await Storage.scan(OrynPath.outboxRoot())
    const existing = await Promise.all(
      ids.map((id) => Storage.read<OutboxEntryT>(OrynPath.outbox(id)).catch(() => undefined)),
    )
    const duplicate = existing.find(
      (e): e is OutboxEntryT => e !== undefined && e.sourceKey === input.sourceKeyHash && e.dedupKey === input.dedupKey,
    )
    if (duplicate) return { entry: duplicate, created: false }
    const entry = OutboxEntry.parse({
      schemaVersion: 2,
      id: Identifier.ascending("oryn_learning"),
      caseId: input.caseId,
      sourceKey: input.sourceKeyHash,
      kind: input.kind,
      text: input.text,
      dedupKey: input.dedupKey,
      createdAt: now(),
    })
    await Storage.write(OrynPath.outbox(entry.id), entry)
    return { entry, created: true }
  }

  export async function listPendingOutbox(): Promise<OutboxEntryT[]> {
    const ids = await Storage.scan(OrynPath.outboxRoot())
    const records = await Promise.all(
      ids.map((id) => Storage.read<OutboxEntryT>(OrynPath.outbox(id)).catch(() => undefined)),
    )
    return records.filter((r): r is OutboxEntryT => r !== undefined && r.state === "pending")
  }

  export async function markOutboxDelivered(entryId: string): Promise<OutboxEntryT> {
    using _lock = await Lock.write(`oryn-outbox:${entryId}`)
    const current = await Storage.read<OutboxEntryT>(OrynPath.outbox(entryId)).catch(() => undefined)
    if (!current) throw storeError("NOT_AUTHORIZED", `outbox entry ${entryId} not found`)
    if (current.state === "delivered") return current
    if (current.state !== "ambiguous") throw storeError("INVALID_STAGE", "notification has no dispatch attempt")
    const next: OutboxEntryT = { ...current, state: "delivered", deliveredAt: now() }
    await Storage.write(OrynPath.outbox(entryId), next)
    return next
  }

  export async function markOutboxSuppressed(entryId: string): Promise<OutboxEntryT> {
    using _lock = await Lock.write(`oryn-outbox:${entryId}`)
    const current = await Storage.read<OutboxEntryT>(OrynPath.outbox(entryId)).catch(() => undefined)
    if (!current) throw storeError("NOT_AUTHORIZED", `outbox entry ${entryId} not found`)
    if (current.state !== "pending") return current
    const next: OutboxEntryT = { ...current, state: "suppressed" }
    await Storage.write(OrynPath.outbox(entryId), next)
    return next
  }

  export async function claimOutboxDelivery(entryId: string): Promise<boolean> {
    using _lock = await Lock.write(`oryn-outbox:${entryId}`)
    const current = await Storage.read<OutboxEntryT>(OrynPath.outbox(entryId))
    if (current.state !== "pending") return false
    await Storage.write(OrynPath.outbox(entryId), {
      ...current,
      state: "ambiguous",
      attemptedAt: now(),
    } satisfies OutboxEntryT)
    return true
  }

  /**
   * Human handoff. Serializes on the case lock with a fresh
   * revision read; takeover semantics apply (control becomes human_owned and
   * the epoch bumps so pending external actions go stale).
   * A stale optional Host snapshot preserves the current record.
   */
  export async function requestHandoff(
    caseId: string,
    reason: string,
    expected?: { revision: number; attemptRevision?: number },
  ): Promise<Case> {
    using _lock = await Lock.write(`oryn-case:${caseId}`)
    const current = await getCase(caseId)
    if (!current) throw storeError("NOT_AUTHORIZED", `case ${caseId} not found`)
    if (expected) {
      if (current.revision !== expected.revision) return current
      const attempt = current.activeAttemptId ? await getAttempt(caseId, current.activeAttemptId) : undefined
      if (attempt?.revision !== expected.attemptRevision) return current
    }
    if (current.control === "human_owned" && current.handoff?.reason === reason) return current
    if (current.control !== "active") throw storeError("HUMAN_OWNED", `case is ${current.control}`)
    const timestamp = now()
    const record: Case = {
      ...current,
      revision: current.revision + 1,
      control: "human_owned",
      epoch: current.epoch + 1,
      handoff: { reason, epoch: current.epoch + 1, requestedAt: timestamp },
      updatedAt: timestamp,
    }
    await writeCase(record)
    return record
  }

  export async function setAssignmentSession(
    caseId: string,
    assignmentId: string,
    sessionID: string,
  ): Promise<Assignment> {
    using _lock = await Lock.write(`oryn-assignment:${caseId}:${assignmentId}`)
    const current = await getAssignment(caseId, assignmentId)
    if (!current) throw storeError("NOT_AUTHORIZED", `assignment ${assignmentId} not found`)
    if (current.sessionId && current.sessionId !== sessionID)
      throw storeError("INVALID_STAGE", "assignment worker identity is already reserved", { caseId })
    if (current.sessionId === sessionID) return current
    const next: Assignment = { ...current, sessionId: sessionID, updatedAt: now() }
    await Storage.write(OrynPath.assignment(caseId, assignmentId), next)
    return next
  }

  /**
   * Compare-and-set the accepted report on an assignment. Re-delivering the
   * same report is idempotent; a different report after acceptance is
   * rejected so frozen judgments cannot be overwritten in place.
   */
  export async function acceptAssignmentReport(
    caseId: string,
    assignmentId: string,
    reportId: string,
  ): Promise<Assignment> {
    using _lock = await Lock.write(`oryn-assignment:${caseId}:${assignmentId}`)
    const current = await getAssignment(caseId, assignmentId)
    if (!current) throw storeError("NOT_AUTHORIZED", `assignment ${assignmentId} not found`)
    if (current.acceptedReportId && current.acceptedReportId !== reportId) {
      throw storeError("INVALID_STAGE", "assignment already accepted a different report", { caseId })
    }
    if (current.acceptedReportId === reportId) return current
    const next: Assignment = { ...current, acceptedReportId: reportId, updatedAt: now() }
    await Storage.write(OrynPath.assignment(caseId, assignmentId), next)
    return next
  }

  /** Host-only: record the worker workspace directory for publishing pushes. */
  export async function setAssignmentWorkspace(
    caseId: string,
    assignmentId: string,
    workspaceRef: string,
  ): Promise<Assignment> {
    using _lock = await Lock.write(`oryn-assignment:${caseId}:${assignmentId}`)
    const current = await getAssignment(caseId, assignmentId)
    if (!current) throw storeError("NOT_AUTHORIZED", `assignment ${assignmentId} not found`)
    if (current.workspaceRef === workspaceRef) return current
    const next: Assignment = { ...current, workspaceRef, updatedAt: now() }
    await Storage.write(OrynPath.assignment(caseId, assignmentId), next)
    return next
  }

  export async function listAssignments(caseId: string): Promise<Assignment[]> {
    const ids = await Storage.scan(OrynPath.assignmentsRoot(caseId))
    const records = await Promise.all(
      ids.map((id) => Storage.read<Assignment>(OrynPath.assignment(caseId, id)).catch(() => undefined)),
    )
    return records.filter((r): r is Assignment => r !== undefined)
  }

  /** Host-only: attach the engineering root session to the case (idempotent). */
  export async function attachEngineeringSession(caseId: string, sessionID: string): Promise<Case> {
    using _lock = await Lock.write(`oryn-case:${caseId}`)
    const current = await getCase(caseId)
    if (!current) throw storeError("NOT_AUTHORIZED", `case ${caseId} not found`)
    if (current.engineeringSessionId === sessionID) return current
    if (current.engineeringSessionId && current.engineeringSessionId !== sessionID) {
      throw storeError("INVALID_STAGE", "case already has a different engineering session", { caseId })
    }
    const record: Case = { ...current, engineeringSessionId: sessionID, updatedAt: now() }
    await writeCase(record)
    return record
  }

  /** Host-only: return the active attempt, creating the initial one at most once. */
  export async function ensureAttempt(
    caseId: string,
    input: { baselineSha: string; baseBranchSha?: string; attemptId?: string },
  ): Promise<Attempt> {
    using _lock = await Lock.write(`oryn-case:${caseId}`)
    const current = await getCase(caseId)
    if (!current) throw storeError("NOT_AUTHORIZED", `case ${caseId} not found`)
    if (current.activeAttemptId) {
      const existing = await getAttempt(caseId, current.activeAttemptId)
      if (existing) return existing
    }
    if (input.attemptId) {
      let reserved: Attempt | undefined
      try {
        reserved = Attempt.parse(await Storage.read(OrynPath.attempt(caseId, input.attemptId)))
      } catch (error) {
        if (!(error instanceof Storage.NotFoundError)) throw error
      }
      if (reserved) {
        if (
          reserved.id !== input.attemptId ||
          reserved.caseId !== caseId ||
          reserved.baselineSha !== input.baselineSha
        ) {
          throw storeError("STALE_REVISION", "reserved attempt identity or baseline changed")
        }
        await writeCase({ ...current, activeAttemptId: reserved.id, updatedAt: now() })
        return reserved
      }
    }
    const ts = now()
    const attempt: Attempt = {
      schemaVersion: 1,
      id: input.attemptId ?? Identifier.ascending("oryn_attempt"),
      caseId,
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
    await Storage.write(OrynPath.attempt(caseId, attempt.id), attempt)
    await writeCase({ ...current, activeAttemptId: attempt.id, updatedAt: now() })
    return attempt
  }

  /** Cases visible to one source (its own submissions plus linked subscriptions). */
  export async function listCasesForSource(sourceKeyHash: string): Promise<Case[]> {
    const link = await getSource(sourceKeyHash)
    if (!link) return []
    const records = await Promise.all(link.caseIds.map((id) => getCase(id)))
    return records.filter((r): r is Case => r !== undefined)
  }

  /** Append run ids to the attempt evidence list (trusted executor path). */
  export async function attachRunEvidence(caseId: string, attemptId: string, runId: string): Promise<Attempt> {
    return mutateAttempt(caseId, attemptId, (draft) => ({
      ...draft,
      evidenceRunIds: draft.evidenceRunIds.includes(runId) ? draft.evidenceRunIds : [...draft.evidenceRunIds, runId],
    }))
  }

  /**
   * Host-only: record remote refs acknowledged through the publish ledger.
   * Issue numbers are single-valued; pull numbers accumulate append-only so
   * replacement PRs keep history.
   */
  export async function attachRemoteRefs(
    caseId: string,
    refs: { issueNumber?: number; pullNumber?: number; expectedEpoch?: number },
  ): Promise<Case> {
    using _lock = await Lock.write(`oryn-case:${caseId}`)
    const current = await getCase(caseId)
    if (!current) throw storeError("NOT_AUTHORIZED", `case ${caseId} not found`)
    if (refs.expectedEpoch !== undefined && current.epoch !== refs.expectedEpoch) return current
    if (
      (!refs.issueNumber || refs.issueNumber === current.issueNumber) &&
      (!refs.pullNumber || current.pullNumbers.includes(refs.pullNumber))
    )
      return current
    const record: Case = {
      ...current,
      issueNumber: refs.issueNumber ?? current.issueNumber,
      pullNumbers:
        refs.pullNumber && !current.pullNumbers.includes(refs.pullNumber)
          ? [...current.pullNumbers, refs.pullNumber]
          : current.pullNumbers,
      updatedAt: now(),
    }
    await writeCase(record)
    return record
  }

  /** Host-validated check plans; models propose, the host approves on run. */
  export async function writeCheckPlan(
    input: Omit<CheckPlan, "schemaVersion" | "id" | "createdAt" | "status"> & { id?: string },
  ): Promise<CheckPlan> {
    const record: CheckPlan = {
      schemaVersion: 1,
      id: input.id ?? Identifier.ascending("oryn_check"),
      caseId: input.caseId,
      attemptId: input.attemptId,
      scenario: input.scenario,
      profileId: input.profileId,
      argv: input.argv,
      checks: input.checks,
      proposedBySessionId: input.proposedBySessionId,
      status: "proposed",
      overlay: input.overlay,
      createdAt: now(),
    }
    await Storage.write(OrynPath.check(record.caseId, record.id), record)
    return record
  }

  export async function getCheckPlan(caseId: string, planId: string): Promise<CheckPlan | undefined> {
    return Storage.read<CheckPlan>(OrynPath.check(caseId, planId)).catch(() => undefined)
  }

  export async function listCheckPlans(caseId: string): Promise<CheckPlan[]> {
    const ids = await Storage.scan(OrynPath.checksRoot(caseId))
    const records = await Promise.all(ids.map((id) => getCheckPlan(caseId, id)))
    return records.filter((r): r is CheckPlan => r !== undefined)
  }

  export async function mutateCheckPlan(
    caseId: string,
    planId: string,
    mutate: (draft: CheckPlan) => CheckPlan,
  ): Promise<CheckPlan> {
    using _lock = await Lock.write(`oryn-check:${caseId}:${planId}`)
    const current = await getCheckPlan(caseId, planId)
    if (!current) throw storeError("NOT_AUTHORIZED", `check plan ${planId} not found`)
    const next = { ...mutate(current) }
    await Storage.write(OrynPath.check(caseId, planId), next)
    return next
  }

  export async function listRuns(caseId: string): Promise<RunReceipt[]> {
    const ids = await Storage.scan(OrynPath.runsRoot(caseId))
    const records = await Promise.all(ids.map((id) => getRun(caseId, id)))
    return records.filter((r): r is RunReceipt => r !== undefined)
  }

  export async function listReviews(caseId: string): Promise<ReviewReport[]> {
    const ids = await Storage.scan(OrynPath.reviewsRoot(caseId))
    const records = await Promise.all(ids.map((id) => getReview(caseId, id)))
    return records.filter((r): r is ReviewReport => r !== undefined)
  }

  export async function listAttempts(caseId: string): Promise<Attempt[]> {
    const ids = await Storage.scan(OrynPath.attemptsRoot(caseId))
    const records = await Promise.all(ids.map((id) => getAttempt(caseId, id)))
    return records.filter((r): r is Attempt => r !== undefined).sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * Rotate the attempt: supersede the active attempt with an invalidation
   * reason, open the next attempt pinned to the previous candidate (so the
   * PR history stays fast-forward), advance the case pointer, and update the
   * rework counters. Serialized under the case lock so a stale worker cannot
   * resurrect the old attempt mid-rotation.
   */
  export async function rotateAttempt(input: {
    caseId: string
    fromAttemptId: string
    invalidationReason: string
    nextBaselineSha: string
    countRepair: boolean
    countNoProgress: boolean
  }): Promise<{ previous: Attempt; next: Attempt; case: Case }> {
    using _lock = await Lock.write(`oryn-case:${input.caseId}`)
    const record = await getCase(input.caseId)
    if (!record) throw storeError("NOT_AUTHORIZED", `case ${input.caseId} not found`)
    return applyAttemptTransition(input, "rework", record)
  }

  function transitionKey(input: { caseId: string; fromAttemptId: string }, kind: "rework" | "resume", epoch: number) {
    return OrynPath.attemptTransition(input.caseId, kind === "resume" ? `resume_${epoch}` : input.fromAttemptId)
  }

  export async function ownershipResume(caseId: string, epoch: number) {
    try {
      const value = AttemptTransition.parse(await Storage.read(OrynPath.attemptTransition(caseId, `resume_${epoch}`)))
      if (value.kind !== "resume" || value.epoch !== epoch || value.input.caseId !== caseId)
        throw storeError("INVALID_STAGE", "Ownership resume identity changed")
      return value
    } catch (error) {
      if (!(error instanceof Storage.NotFoundError)) throw error
    }
  }

  async function applyAttemptTransition(
    input: z.infer<typeof AttemptTransition>["input"],
    kind: "rework" | "resume",
    record: Case,
  ): Promise<{ previous: Attempt; next: Attempt; case: Case }> {
    const key = transitionKey(input, kind, record.epoch)
    let transition: z.infer<typeof AttemptTransition> | undefined
    try {
      transition = AttemptTransition.parse(await Storage.read(key))
    } catch (error) {
      if (!(error instanceof Storage.NotFoundError)) throw error
    }
    if (
      transition &&
      Object.entries(input).some(([key, value]) => transition!.input[key as keyof typeof input] !== value)
    )
      throw storeError("INVALID_STAGE", "Attempt transition input changed")
    if (
      (transition && (transition.epoch !== record.epoch || transition.kind !== kind)) ||
      (kind === "rework" && record.control !== "active")
    )
      throw storeError("HUMAN_OWNED", "Attempt transition ownership changed")
    if (transition && record.activeAttemptId === transition.next.id) {
      const previous = await getAttempt(input.caseId, input.fromAttemptId)
      const next = await getAttempt(input.caseId, transition.next.id)
      if (!previous || !next) throw storeError("INVALID_STAGE", "Completed Attempt transition is missing its records")
      await writeCase(record)
      return { previous, next, case: record }
    }
    if (transition && record.control !== transition.expectedControl)
      throw storeError("HUMAN_OWNED", "Attempt transition control changed")
    if (record.activeAttemptId !== input.fromAttemptId)
      throw storeError("INVALID_STAGE", "rotation targets a non-active attempt", { caseId: input.caseId })
    const previous = await getAttempt(input.caseId, input.fromAttemptId)
    if (!previous) throw storeError("NOT_AUTHORIZED", `attempt ${input.fromAttemptId} not found`)
    if (!transition) {
      const ts = now()
      transition = {
        schemaVersion: 2,
        kind,
        expectedControl: record.control,
        input,
        epoch: record.epoch,
        expectedRevision: record.revision,
        repairRounds: record.repairRounds + (input.countRepair ? 1 : 0),
        noProgressRounds:
          kind === "resume" ? record.noProgressRounds : input.countNoProgress ? record.noProgressRounds + 1 : 0,
        next: {
          schemaVersion: 1,
          id: Identifier.ascending("oryn_attempt"),
          caseId: input.caseId,
          revision: 0,
          baselineSha: input.nextBaselineSha,
          ...(previous.baseBranchSha ? { baseBranchSha: previous.baseBranchSha } : {}),
          assignmentIds: [],
          evidenceRunIds: [],
          reviewIds: [],
          disposition: "open",
          createdAt: ts,
          updatedAt: ts,
        },
      }
      await Storage.write(key, transition)
    }
    if (record.revision !== transition.expectedRevision)
      throw storeError("STALE_REVISION", "Case changed during Attempt transition")
    let next: Attempt | undefined
    try {
      next = Attempt.parse(await Storage.read(OrynPath.attempt(input.caseId, transition.next.id)))
    } catch (error) {
      if (!(error instanceof Storage.NotFoundError)) throw error
    }
    if (next && JSON.stringify(next) !== JSON.stringify(transition.next))
      throw storeError("INVALID_STAGE", "Reserved Attempt changed before activation")
    if (!next) {
      next = transition.next
      await Storage.write(OrynPath.attempt(input.caseId, next.id), next)
    }
    const superseded =
      previous.disposition === "superseded" && previous.invalidationReason === input.invalidationReason
        ? previous
        : await mutateAttempt(input.caseId, input.fromAttemptId, (draft) => ({
            ...draft,
            disposition: "superseded",
            invalidationReason: input.invalidationReason,
          }))
    const updated: Case = {
      ...record,
      revision: record.revision + 1,
      activeAttemptId: next.id,
      control: "active",
      repairRounds: transition.repairRounds,
      noProgressRounds: transition.noProgressRounds,
      updatedAt: now(),
    }
    await writeCase(updated)
    return { previous: superseded, next, case: updated }
  }

  export async function recoverAttemptTransitions() {
    const result = { recovered: 0, failed: 0 }
    for (const record of await listCases()) {
      for (const fromId of await Storage.scan(OrynPath.attemptTransitionsRoot(record.id))) {
        try {
          const transition = AttemptTransition.parse(await Storage.read(OrynPath.attemptTransition(record.id, fromId)))
          if (
            transition.input.caseId !== record.id ||
            transitionKey(transition.input, transition.kind, transition.epoch).at(-1) !== fromId ||
            transition.next.caseId !== record.id
          )
            throw storeError("INVALID_STAGE", "Attempt transition does not belong to its storage key")
          using _lock = await Lock.write(`oryn-case:${record.id}`)
          const current = await getCase(record.id)
          if (!current || current.control === "closed") break
          if (
            transition.epoch !== current.epoch ||
            ![transition.input.fromAttemptId, transition.next.id].includes(current.activeAttemptId ?? "")
          )
            continue
          if (
            current.control !== transition.expectedControl &&
            !(current.control === "active" && current.activeAttemptId === transition.next.id)
          )
            continue
          await applyAttemptTransition(transition.input, transition.kind, current)
          result.recovered++
        } catch {
          result.failed++
          const current = await getCase(record.id)
          if (current?.control === "active") await control(current.id, current.revision, "pause")
        }
      }
    }
    return result
  }
}
