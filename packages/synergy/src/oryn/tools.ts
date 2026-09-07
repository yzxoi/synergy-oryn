import z from "zod"
import { Tool } from "../tool/tool"
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

const DispatchParameters = z.object({
  caseId: z.string().min(1),
  attemptId: z.string().optional().describe("Defaults to the case's active attempt"),
  stage: z.enum(["repro", "code", "verify", "review"]),
  requestKey: z
    .string()
    .min(1)
    .max(200)
    .describe("Unique key for this dispatch; repeated keys return the existing worker, not a new one"),
  reviewDomain: z.enum(["general", "persistence", "security", "channel", "publishing"]).optional(),
})

export const OrynDispatchTool = Tool.define(
  "oryn_dispatch",
  {
    description:
      "Request the next engineering stage for your case. The host picks the agent, workspace, and frozen inputs — you request a stage, never an agent. Repeated requestKeys dedupe to the existing worker.",
    parameters: DispatchParameters,
    async execute(params, ctx): Promise<Tool.ExecutionResult> {
      return execute(async () => {
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

export function registerOrynTools(): Tool.Info[] {
  return [OrynCaseTool, OrynDispatchTool, OrynResultTool, OrynReplyTool]
}
