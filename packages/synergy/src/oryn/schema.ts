import z from "zod"

/**
 * Oryn record schemas. These are the durable business records of the
 * feedback-to-PR pipeline. Host-only fields (identity binding, epochs,
 * digests, remote receipts) live here; model-facing tool schemas derive a
 * narrower view so the model can never write identity, authorization, or
 * execution-trust fields.
 *
 * Every mutating input carries a requestKey for idempotency and the caller
 * supplies an expectedRevision for compare-and-set on case records.
 */

export const CaseControl = z.enum(["active", "paused", "human_owned", "cancelled", "closed"])
export type CaseControl = z.infer<typeof CaseControl>

export const CaseKind = z.enum(["bug", "feature", "question", "performance", "usage"])
export type CaseKind = z.infer<typeof CaseKind>

export const ReportAuthenticity = z.enum(["synthetic", "built_runtime", "live_test_tenant", "manual_observation"])
export type ReportAuthenticity = z.infer<typeof ReportAuthenticity>

export const RunOutcome = z.enum(["passed", "failed", "inconclusive", "cancelled"])
export type RunOutcome = z.infer<typeof RunOutcome>

export const RunLane = z.enum(["baseline", "candidate", "experiment"])
export type RunLane = z.infer<typeof RunLane>

export const Stage = z.enum(["repro", "code", "verify", "review"])
export type Stage = z.infer<typeof Stage>

export const AttemptDisposition = z.enum(["open", "candidate_frozen", "ready", "superseded", "failed", "handed_off"])
export type AttemptDisposition = z.infer<typeof AttemptDisposition>

export const ActionState = z.enum(["prepared", "in_flight", "acknowledged", "ambiguous", "rejected", "cancelled"])
export type ActionState = z.infer<typeof ActionState>

export const PublishOperation = z.enum([
  "ensure_issue",
  "ensure_draft",
  "refresh_pr",
  "publish_review",
  "mark_ready",
  "notify_feishu",
])
export type PublishOperation = z.infer<typeof PublishOperation>

export const Recommendation = z.enum(["changes_required", "needs_human", "ready_for_human"])
export type Recommendation = z.infer<typeof Recommendation>

export const FindingSeverity = z.enum(["P0", "P1", "P2", "P3"])
export type FindingSeverity = z.infer<typeof FindingSeverity>

export const FindingDisposition = z.enum(["open", "resolved", "rejected_with_evidence", "still_open"])
export type FindingDisposition = z.infer<typeof FindingDisposition>

export const ReviewDomain = z.enum(["general", "persistence", "security", "channel", "publishing"])
export type ReviewDomain = z.infer<typeof ReviewDomain>

export const SourceIdentity = z
  .object({
    provider: z.enum(["feishu", "github"]),
    accountId: z.string().min(1),
    chatId: z.string().optional(),
    threadId: z.string().optional(),
    messageId: z.string().optional(),
    repo: z.string().optional(),
    issueNumber: z.number().int().positive().optional(),
    eventName: z.string().optional(),
  })
  .strict()
export type SourceIdentity = z.infer<typeof SourceIdentity>

export const SourceLink = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    /** Hash of the normalized identity; raw IDs stay only inside this record. */
    key: z.string().min(1),
    identity: SourceIdentity,
    reporter: z.string().optional(),
    qaSessionId: z.string().optional(),
    visibility: z.enum(["private", "subscribers"]),
    caseIds: z.array(z.string()).default([]),
    createdAt: z.number().int().positive(),
  })
  .strict()
export type SourceLink = z.infer<typeof SourceLink>

export const IntakeClaim = z
  .object({
    schemaVersion: z.literal(1),
    /** Normalized source key hash; the storage path uses this hash. */
    sourceKey: z.string().min(1),
    /** Fixed at claim time so every recovery step binds to the same case. */
    caseId: z.string().min(1),
    requestKey: z.string().min(1),
    state: z.enum(["claimed", "case_created", "linked", "session_started", "completed", "failed"]),
    createdAt: z.number().int().positive(),
    updatedAt: z.number().int().positive(),
  })
  .strict()
export type IntakeClaim = z.infer<typeof IntakeClaim>

export const HumanDecision = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    caseId: z.string().min(1),
    question: z.string().min(1),
    acceptedScopeDigest: z.string().min(1),
    applicableAttemptIds: z.array(z.string()).default([]),
    actor: z.enum(["operator", "reporter", "maintainer"]),
    disposition: z.enum(["approved", "rejected", "deferred"]),
    decidedAt: z.number().int().positive(),
  })
  .strict()
export type HumanDecision = z.infer<typeof HumanDecision>

export const Case = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    revision: z.number().int().nonnegative(),
    kind: CaseKind,
    /** Redacted before storage; raw chat text never enters the Case record. */
    summary: z.string().min(1),
    observed: z.string().optional(),
    expected: z.string().optional(),
    repoAlias: z.string().min(1),
    sourceIds: z.array(z.string()).default([]),
    engineeringSessionId: z.string().optional(),
    qaScopeId: z.string().optional(),
    workScopeId: z.string().optional(),
    activeAttemptId: z.string().optional(),
    issueNumber: z.number().int().positive().optional(),
    pullNumbers: z.array(z.number().int().positive()).default([]),
    control: CaseControl.default("active"),
    /** Digest of the accepted acceptance criteria; amendment rotation bumps this. */
    acceptanceDigest: z.string().min(1),
    acceptanceRevision: z.number().int().nonnegative().default(0),
    epoch: z.number().int().nonnegative().default(0),
    repairRounds: z.number().int().nonnegative().default(0),
    noProgressRounds: z.number().int().nonnegative().default(0),
    humanDecisions: z.array(z.string()).default([]),
    createdAt: z.number().int().positive(),
    updatedAt: z.number().int().positive(),
  })
  .strict()
export type Case = z.infer<typeof Case>

export const Attempt = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    caseId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    baselineSha: z.string().min(1),
    candidateSha: z.string().optional(),
    baseBranchSha: z.string().optional(),
    planDigest: z.string().optional(),
    assignmentIds: z.array(z.string()).default([]),
    evidenceRunIds: z.array(z.string()).default([]),
    reviewIds: z.array(z.string()).default([]),
    disposition: AttemptDisposition.default("open"),
    invalidationReason: z.string().optional(),
    createdAt: z.number().int().positive(),
    updatedAt: z.number().int().positive(),
  })
  .strict()
export type Attempt = z.infer<typeof Attempt>

export const Assignment = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    caseId: z.string().min(1),
    attemptId: z.string().min(1),
    stage: Stage,
    agentId: z.string().min(1),
    sessionId: z.string().optional(),
    workspaceRef: z.string().optional(),
    frozenInputsDigest: z.string().min(1),
    requestKey: z.string().min(1),
    epoch: z.number().int().nonnegative(),
    reviewDomain: ReviewDomain.optional(),
    acceptedReportId: z.string().optional(),
    createdAt: z.number().int().positive(),
    updatedAt: z.number().int().positive(),
  })
  .strict()
export type Assignment = z.infer<typeof Assignment>

export const RunReceipt = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    assignmentId: z.string().min(1),
    caseId: z.string().min(1),
    attemptId: z.string().min(1),
    planDigest: z.string().min(1),
    lane: RunLane,
    actualSha: z.string().optional(),
    treeDigest: z.string().optional(),
    buildSummary: z.string().optional(),
    profile: z.string().min(1),
    argvSummary: z.string().min(1),
    startedAt: z.number().int().positive(),
    endedAt: z.number().int().positive(),
    exitCode: z.number().int(),
    observations: z.array(z.string()).max(64).default([]),
    artifactDigests: z.array(z.string()).max(32).default([]),
    authenticity: ReportAuthenticity,
    outcome: RunOutcome,
    /** True when the run executed with a verification overlay patch applied. */
    overlayApplied: z.boolean().default(false),
    infrastructureFailure: z.boolean().default(false),
  })
  .strict()
export type RunReceipt = z.infer<typeof RunReceipt>

export const Finding = z
  .object({
    id: z.string().min(1),
    severity: FindingSeverity,
    category: z.string().min(1),
    path: z.string().optional(),
    line: z.number().int().positive().optional(),
    trigger: z.string().min(1),
    impact: z.string().min(1),
    evidenceRefs: z.array(z.string()).default([]),
    disposition: FindingDisposition.default("open"),
  })
  .strict()
export type Finding = z.infer<typeof Finding>

export const ReviewReport = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    assignmentId: z.string().min(1),
    caseId: z.string().min(1),
    attemptId: z.string().min(1),
    headSha: z.string().min(1),
    baseSha: z.string().min(1),
    policyDigest: z.string().min(1),
    evidenceDigest: z.string().min(1),
    domain: ReviewDomain.default("general"),
    findings: z.array(Finding).max(64).default([]),
    questions: z.array(z.string()).max(16).default([]),
    evidenceAssessment: z.string().min(1),
    designDecisions: z.array(z.string()).max(16).default([]),
    recommendation: Recommendation,
    limitedScope: z.string().optional(),
    createdAt: z.number().int().positive(),
  })
  .strict()
export type ReviewReport = z.infer<typeof ReviewReport>

export const ActionReceipt = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    caseId: z.string().min(1),
    operation: PublishOperation,
    payloadDigest: z.string().min(1),
    expectedHead: z.string().optional(),
    expectedRevision: z.number().int().nonnegative(),
    epoch: z.number().int().nonnegative(),
    requestKey: z.string().min(1),
    state: ActionState,
    remoteRefs: z
      .object({
        issueNumber: z.number().int().positive().optional(),
        pullNumber: z.number().int().positive().optional(),
        branch: z.string().optional(),
        url: z.string().optional(),
        commentId: z.number().int().positive().optional(),
        checkRunId: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    attempts: z.number().int().nonnegative().default(0),
    lastErrorClass: z.string().optional(),
    createdAt: z.number().int().positive(),
    updatedAt: z.number().int().positive(),
  })
  .strict()
export type ActionReceipt = z.infer<typeof ActionReceipt>

export const LearningCandidate = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    caseId: z.string().min(1),
    outcomeVersion: z.string().min(1),
    lesson: z.string().min(1),
    applicability: z.string().min(1),
    invalidation: z.string().min(1),
    evidenceRefs: z.array(z.string()).min(1),
    promotionState: z.enum(["proposed", "verified", "promoted", "rejected"]),
    memoryRef: z.string().optional(),
    createdAt: z.number().int().positive(),
    updatedAt: z.number().int().positive(),
  })
  .strict()
export type LearningCandidate = z.infer<typeof LearningCandidate>

export const OrynErrorCodes = [
  "NOT_AUTHORIZED",
  "STALE_REVISION",
  "STALE_HEAD",
  "INVALID_STAGE",
  "ENVIRONMENT_UNAVAILABLE",
  "BUDGET_EXHAUSTED",
  "HUMAN_OWNED",
  "EVIDENCE_INSUFFICIENT",
  "REMOTE_AMBIGUOUS",
] as const
export type OrynErrorCode = (typeof OrynErrorCodes)[number]
