import z from "zod"
import { Tool } from "../tool/tool"
import { Finding } from "./schema"
import { OrynService } from "./service"
import { OrynStore, OrynStoreError } from "./store"

function toolError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

function toToolError(error: unknown): Error {
  if (error instanceof Error && error.name === OrynStoreError.name) {
    const data = (error as { data?: { code?: string; message?: string } }).data
    return toolError(data?.code ?? "ORYN_ERROR", data?.message ?? error.message)
  }
  return error instanceof Error ? error : new Error(String(error))
}

async function execute(fn: () => Promise<Tool.ExecutionResult>): Promise<Tool.ExecutionResult> {
  try {
    return await fn()
  } catch (error) {
    throw toToolError(error)
  }
}

const CaseAction = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("submit"),
      requestKey: z.string().min(1).max(200).describe("Unique key for this submission; replays return the same case"),
      kind: z.enum(["bug", "feature", "question", "performance", "usage"]),
      summary: z.string().min(1).max(2000).describe("Redacted one-line problem summary (no raw chat text)"),
      observed: z.string().max(4000).optional().describe("What actually happens, redacted"),
      expected: z.string().max(4000).optional().describe("What should happen instead; becomes the acceptance target"),
    })
    .describe("File engineering feedback as a case routed by the host configuration"),
  z
    .object({
      action: z.literal("get"),
      caseId: z.string().min(1),
    })
    .describe("Read one of your linked cases"),
  z
    .object({
      action: z.literal("list"),
    })
    .describe("List cases linked to your source"),
  z
    .object({
      action: z.literal("amend"),
      caseId: z.string().min(1),
      expectedRevision: z.number().int().nonnegative(),
      observed: z.string().max(4000).optional(),
      expected: z.string().max(4000).optional(),
    })
    .describe("Amend observable/expected details; rotates the acceptance digest"),
  z
    .object({
      action: z.literal("request_handoff"),
      caseId: z.string().min(1),
      reason: z.string().min(1).max(2000).describe("Specific gap: what is blocked and why"),
    })
    .describe("Hand the case to a human operator"),
])

async function requireBinding(sessionID: string) {
  const binding = await OrynStore.sessionSourceBinding(sessionID)
  if (!binding) throw toolError("NOT_AUTHORIZED", "session has no Oryn source binding")
  return binding
}

export const OrynCaseTool = Tool.define(
  "oryn_case",
  {
    description:
      "Oryn case operations: submit engineering feedback (routed by host config), get/list your linked cases, amend acceptance details, or request human handoff. Identity and routing come from your session binding, never from parameters.",
    parameters: CaseAction,
    async execute(params, ctx): Promise<Tool.ExecutionResult> {
      return execute(async () => {
        if (params.action === "submit") {
          const result = await OrynService.submitCase({
            callerSessionID: ctx.sessionID,
            requestKey: params.requestKey,
            kind: params.kind,
            summary: params.summary,
            observed: params.observed,
            expected: params.expected,
          })
          return {
            title: result.created ? "Case submitted" : "Case already exists",
            output: `caseId: ${result.caseId}\nrevision: ${result.revision}\nrepoAlias: ${result.repoAlias}\ncreated: ${result.created}`,
            metadata: { caseId: result.caseId, revision: result.revision, created: result.created },
          }
        }
        if (params.action === "get") {
          const binding = await requireBinding(ctx.sessionID)
          const record = await OrynStore.getCaseForSource(params.caseId, binding.sourceKey)
          return {
            title: `Case ${record.id}`,
            output: JSON.stringify(
              {
                caseId: record.id,
                revision: record.revision,
                kind: record.kind,
                summary: record.summary,
                observed: record.observed,
                expected: record.expected,
                repoAlias: record.repoAlias,
                control: record.control,
                activeAttemptId: record.activeAttemptId,
                acceptanceRevision: record.acceptanceRevision,
                repairRounds: record.repairRounds,
                noProgressRounds: record.noProgressRounds,
                issueNumber: record.issueNumber,
                pullNumbers: record.pullNumbers,
              },
              null,
              2,
            ),
            metadata: { caseId: record.id, revision: record.revision, control: record.control },
          }
        }
        if (params.action === "list") {
          const binding = await requireBinding(ctx.sessionID)
          const records = await OrynStore.listCasesForSource(binding.sourceKey)
          return {
            title: `${records.length} case(s)`,
            output: JSON.stringify(
              records.map((r) => ({
                caseId: r.id,
                kind: r.kind,
                summary: r.summary,
                control: r.control,
                revision: r.revision,
                issueNumber: r.issueNumber,
              })),
              null,
              2,
            ),
            metadata: { count: records.length },
          }
        }
        if (params.action === "amend") {
          const binding = await requireBinding(ctx.sessionID)
          await OrynStore.getCaseForSource(params.caseId, binding.sourceKey)
          const record = await OrynStore.amendAcceptance(params.caseId, params.expectedRevision, {
            observed: params.observed,
            expected: params.expected,
          })
          return {
            title: "Case amended",
            output: `caseId: ${record.id}\nrevision: ${record.revision}\nacceptanceRevision: ${record.acceptanceRevision}`,
            metadata: { caseId: record.id, revision: record.revision, acceptanceRevision: record.acceptanceRevision },
          }
        }
        const binding = await requireBinding(ctx.sessionID)
        await OrynStore.getCaseForSource(params.caseId, binding.sourceKey)
        const record = await OrynStore.requestHandoff(params.caseId, params.reason)
        return {
          title: "Handed off to human",
          output: `caseId: ${record.id}\ncontrol: ${record.control}\nepoch: ${record.epoch}`,
          metadata: { caseId: record.id, control: record.control, epoch: record.epoch },
        }
      })
    },
  },
  {
    exposure: { mode: "resident" },
  },
)

const DispatchParameters = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("dispatch"),
    caseId: z.string().min(1),
    attemptId: z.string().optional().describe("Defaults to the case's active attempt"),
    stage: z.enum(["repro", "code", "verify", "review"]),
    requestKey: z
      .string()
      .min(1)
      .max(200)
      .describe("Unique key for this dispatch; repeated keys return the existing worker, not a new one"),
    reviewDomain: z.enum(["general", "persistence", "security", "channel", "publishing"]).optional(),
  }),
  z.object({
    action: z.literal("rework"),
    caseId: z.string().min(1),
    reason: z.string().min(1).max(2000).describe("What review found or why the frozen candidate must be redone"),
  }),
])

export const OrynDispatchTool = Tool.define(
  "oryn_dispatch",
  {
    description:
      "Request the next engineering stage for your case (dispatch), or open a bounded rework round on the frozen candidate when review demands changes (rework). The host picks the agent, workspace, and frozen inputs. Repeated dispatch requestKeys dedupe to the existing worker.",
    parameters: DispatchParameters,
    async execute(params, ctx): Promise<Tool.ExecutionResult> {
      return execute(async () => {
        if (params.action === "rework") {
          const result = await OrynService.rework({
            callerSessionID: ctx.sessionID,
            caseId: params.caseId,
            reason: params.reason,
          })
          return {
            title: result.handedOff ? "Rework cap reached — handed to human" : "Attempt rotated for rework",
            output: `attemptId: ${result.attemptId}\nrepairRounds: ${result.repairRounds}\nnoProgressRounds: ${result.noProgressRounds}\nhandedOff: ${result.handedOff}`,
            metadata: { ...result },
          }
        }
        const result = await OrynService.dispatch({
          callerSessionID: ctx.sessionID,
          caseId: params.caseId,
          attemptId: params.attemptId,
          stage: params.stage,
          requestKey: params.requestKey,
          reviewDomain: params.reviewDomain,
        })
        return {
          title: result.deduped ? "Dispatch deduplicated" : `Dispatched ${params.stage}`,
          output: `assignmentId: ${result.assignmentId}\nworkerSessionId: ${result.workerSessionId}\ndeduped: ${result.deduped}`,
          metadata: { ...result },
        }
      })
    },
  },
  {
    exposure: { mode: "resident" },
  },
)

const ResultParameters = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("get"),
    caseId: z.string().min(1),
    reportId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("repro"),
    caseId: z.string().min(1),
    attemptId: z.string().min(1),
    assignmentId: z.string().min(1),
    requestKey: z.string().min(1).max(200),
    outcome: z.enum(["reproduced", "already_fixed", "inconclusive", "needs_human"]),
    summary: z.string().min(1).max(4000),
    runIds: z.array(z.string()).max(32).optional().describe("Trusted run receipt ids backing this judgment"),
    limitations: z.array(z.string()).max(16).optional(),
  }),
  z.object({
    kind: z.literal("candidate"),
    caseId: z.string().min(1),
    attemptId: z.string().min(1),
    assignmentId: z.string().min(1),
    requestKey: z.string().min(1).max(200),
    outcome: z.enum(["candidate_ready", "blocked"]),
    summary: z.string().min(1).max(4000),
    localBranch: z.string().min(1).optional(),
    candidateSha: z.string().min(1).optional().describe("Commit SHA of your candidate; the host verifies it"),
    addressedFindings: z.array(z.string()).max(64).optional(),
    knownRisks: z.array(z.string()).max(16).optional(),
    limitations: z.array(z.string()).max(16).optional(),
  }),
  z.object({
    kind: z.literal("verification"),
    caseId: z.string().min(1),
    attemptId: z.string().min(1),
    assignmentId: z.string().min(1),
    requestKey: z.string().min(1).max(200),
    outcome: z.enum(["verified", "failed", "inconclusive", "needs_human"]),
    summary: z.string().min(1).max(4000),
    runIds: z.array(z.string()).max(32).optional(),
    limitations: z.array(z.string()).max(16).optional(),
  }),
  z.object({
    kind: z.literal("review"),
    caseId: z.string().min(1),
    attemptId: z.string().min(1),
    assignmentId: z.string().min(1),
    requestKey: z.string().min(1).max(200),
    headSha: z.string().min(1).describe("Candidate SHA under review; must match the frozen candidate"),
    baseSha: z.string().min(1).describe("Attempt baseline SHA the candidate builds on"),
    domain: z.enum(["general", "persistence", "security", "channel", "publishing"]).optional(),
    findings: z
      .array(Finding)
      .max(64)
      .describe("Findings: id, severity P0-P3, category, trigger, impact, and explicit disposition for prior findings"),
    questions: z.array(z.string()).max(16).optional(),
    evidenceAssessment: z.string().min(1).max(4000),
    designDecisions: z.array(z.string()).max(16).optional(),
    recommendation: z.enum(["changes_required", "needs_human", "ready_for_human"]),
    limitedScope: z.string().min(1).max(1000).optional(),
  }),
  z.object({
    kind: z.literal("review_note"),
    caseId: z.string().min(1),
    attemptId: z.string().min(1),
    assignmentId: z.string().min(1),
    requestKey: z.string().min(1).max(200),
    outcome: z.string().min(1).max(64),
    summary: z.string().min(1).max(4000),
    limitations: z.array(z.string()).max(16).optional(),
  }),
])

export const OrynResultTool = Tool.define(
  "oryn_result",
  {
    description:
      "Submit your structured worker outcome for an assignment, or read a previously submitted report. The host validates the assignment belongs to your session; stale-epoch reports are archived but not accepted.",
    parameters: ResultParameters,
    async execute(params, ctx): Promise<Tool.ExecutionResult> {
      return execute(async () => {
        if (params.kind === "get") {
          const report = await OrynStore.getWorkerReport(params.caseId, params.reportId)
          if (!report) throw toolError("NOT_AUTHORIZED", `report ${params.reportId} not found`)
          return {
            title: `Report ${report.id}`,
            output: JSON.stringify(report, null, 2),
            metadata: { reportId: report.id, reportKind: report.kind },
          }
        }
        if (params.kind === "review") {
          const result = await OrynService.submitReview({
            callerSessionID: ctx.sessionID,
            caseId: params.caseId,
            attemptId: params.attemptId,
            assignmentId: params.assignmentId,
            requestKey: params.requestKey,
            headSha: params.headSha,
            baseSha: params.baseSha,
            domain: params.domain,
            findings: params.findings,
            questions: params.questions,
            evidenceAssessment: params.evidenceAssessment,
            designDecisions: params.designDecisions,
            recommendation: params.recommendation,
            limitedScope: params.limitedScope,
          })
          return {
            title: result.stale ? "Review archived (stale epoch)" : "Review accepted",
            output: `reviewId: ${result.reviewId}\naccepted: ${result.accepted}\nstale: ${result.stale}`,
            metadata: { ...result },
          }
        }
        const result = await OrynService.submitResult({
          callerSessionID: ctx.sessionID,
          caseId: params.caseId,
          attemptId: params.attemptId,
          assignmentId: params.assignmentId,
          requestKey: params.requestKey,
          kind: params.kind,
          outcome: params.outcome,
          summary: params.summary,
          localBranch: "localBranch" in params ? params.localBranch : undefined,
          candidateSha: "candidateSha" in params ? params.candidateSha : undefined,
          runIds: "runIds" in params ? params.runIds : undefined,
          knownRisks: "knownRisks" in params ? params.knownRisks : undefined,
          limitations: "limitations" in params ? params.limitations : undefined,
        })
        return {
          title: result.stale ? "Report archived (stale epoch)" : "Report accepted",
          output: `reportId: ${result.reportId}\naccepted: ${result.accepted}\nstale: ${result.stale}`,
          metadata: { ...result },
        }
      })
    },
  },
  {
    exposure: { mode: "resident" },
  },
)

const ReplyParameters = z.object({
  kind: z.enum(["answer", "clarification", "accepted", "needs_human", "ready", "released"]),
  text: z.string().min(1).max(4000).describe("User-facing text; no internal identifiers, paths, or credentials"),
  caseId: z.string().min(1).optional().describe("Defaults to your bound case when you are an engineering session"),
})

export const OrynReplyTool = Tool.define(
  "oryn_reply",
  {
    description:
      "Deliver a bounded result to the reporter of your bound source. The host resolves the chat from your session binding — you never name an account or chat id. Repeated ready/needs_human replies for the same case dedupe to one delivery.",
    parameters: ReplyParameters,
    async execute(params, ctx): Promise<Tool.ExecutionResult> {
      return execute(async () => {
        const result = await OrynService.reply({
          callerSessionID: ctx.sessionID,
          caseId: params.caseId,
          kind: params.kind,
          text: params.text,
        })
        return {
          title: result.created ? "Queued for delivery" : "Already queued (deduplicated)",
          output: `entryId: ${result.entryId}\ncreated: ${result.created}`,
          metadata: { ...result },
        }
      })
    },
  },
  {
    exposure: { mode: "resident" },
  },
)

const CheckParameters = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("propose"),
      caseId: z.string().min(1),
      attemptId: z.string().min(1),
      assignmentId: z.string().min(1),
      scenario: z.string().min(1).max(2000).describe("What behavior this plan asserts and how it is triggered"),
      profileId: z.string().min(1).describe("Execution profile from oryn.executionProfiles"),
      argv: z
        .array(z.array(z.string().min(1)).min(1).max(8))
        .min(1)
        .max(8)
        .describe("Concrete command lines; each first token must be allowlisted by the profile"),
      checks: z.array(z.string().min(1).max(500)).min(1).max(16).describe("Assertions this run must reach"),
      overlay: z.boolean().optional().describe("Declare that this run applies a verification overlay patch"),
    })
    .describe("Propose a verification plan; it is approved when the host executes it"),
  z
    .object({
      action: z.literal("run"),
      caseId: z.string().min(1),
      attemptId: z.string().min(1),
      assignmentId: z.string().min(1),
      planId: z.string().min(1),
      lane: z.enum(["baseline", "candidate", "experiment"]),
    })
    .describe("Execute an approved plan through the trusted executor; only its receipt is evidence"),
  z
    .object({
      action: z.literal("get"),
      caseId: z.string().min(1),
      planId: z.string().min(1),
    })
    .describe("Read a check plan"),
])

export const OrynCheckTool = Tool.define(
  "oryn_check",
  {
    description:
      "Verification runs: propose a check plan (scenario, profile, commands, assertions), execute it through the trusted executor in your assigned workspace, or read a plan. Local runs you did with bash are development aid — only receipts from this executor count as evidence.",
    parameters: CheckParameters,
    async execute(params, ctx): Promise<Tool.ExecutionResult> {
      return execute(async () => {
        if (params.action === "propose") {
          const result = await OrynService.proposeCheck({
            callerSessionID: ctx.sessionID,
            caseId: params.caseId,
            attemptId: params.attemptId,
            assignmentId: params.assignmentId,
            scenario: params.scenario,
            profileId: params.profileId,
            argv: params.argv,
            checks: params.checks,
            overlay: params.overlay,
          })
          return {
            title: "Check plan proposed",
            output: `planId: ${result.planId}\nstatus: proposed (approved on run)`,
            metadata: { planId: result.planId },
          }
        }
        if (params.action === "run") {
          const result = await OrynService.runCheck({
            callerSessionID: ctx.sessionID,
            caseId: params.caseId,
            attemptId: params.attemptId,
            assignmentId: params.assignmentId,
            planId: params.planId,
            lane: params.lane,
            abort: ctx.abort,
          })
          return {
            title: `Run ${result.outcome}`,
            output: `runId: ${result.runId}\noutcome: ${result.outcome}\noverlayApplied: ${result.overlayApplied}`,
            metadata: { ...result },
          }
        }
        const plan = await OrynService.getCheck({
          callerSessionID: ctx.sessionID,
          caseId: params.caseId,
          planId: params.planId,
        })
        return {
          title: `Check plan ${plan.id}`,
          output: JSON.stringify(
            {
              planId: plan.id,
              status: plan.status,
              scenario: plan.scenario,
              profileId: plan.profileId,
              argv: plan.argv,
              checks: plan.checks,
              overlay: plan.overlay,
            },
            null,
            2,
          ),
          metadata: { planId: plan.id, status: plan.status },
        }
      })
    },
  },
  {
    exposure: { mode: "resident" },
  },
)

export function registerOrynTools(): Tool.Info[] {
  return [OrynCaseTool, OrynDispatchTool, OrynResultTool, OrynCheckTool, OrynReplyTool]
}
