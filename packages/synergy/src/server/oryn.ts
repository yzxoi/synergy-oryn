import { Hono, type Context } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { OrynStore } from "../oryn/store"
import { OrynConfig } from "../oryn/register"
import { errors } from "./error"

const OrynErrorResponse = z
  .object({ message: z.string(), code: z.string() })
  .strict()
  .meta({ ref: "OrynErrorResponse" })

const CaseListItem = z
  .object({
    id: z.string(),
    revision: z.number().int(),
    kind: z.string(),
    summary: z.string(),
    repoAlias: z.string(),
    control: z.string(),
    activeAttemptId: z.string().optional(),
    issueNumber: z.number().int().optional(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .strict()
  .meta({ ref: "OrynCaseListItem" })

const CaseListResponse = z
  .object({ cases: z.array(CaseListItem) })
  .strict()
  .meta({ ref: "OrynCaseListResponse" })

const CaseDetailResponse = z
  .object({
    id: z.string(),
    revision: z.number().int(),
    kind: z.string(),
    summary: z.string(),
    observed: z.string().optional(),
    expected: z.string().optional(),
    repoAlias: z.string(),
    control: z.string(),
    acceptanceRevision: z.number().int(),
    epoch: z.number().int(),
    repairRounds: z.number().int(),
    noProgressRounds: z.number().int(),
    activeAttemptId: z.string().optional(),
    issueNumber: z.number().int().optional(),
    pullNumbers: z.array(z.number().int()),
    sourceCount: z.number().int(),
    humanDecisions: z.array(z.string()),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .strict()
  .meta({ ref: "OrynCaseDetailResponse" })

const AttemptResponse = z
  .object({
    id: z.string(),
    caseId: z.string(),
    revision: z.number().int(),
    baselineSha: z.string(),
    candidateSha: z.string().optional(),
    baseBranchSha: z.string().optional(),
    disposition: z.string(),
    assignmentIds: z.array(z.string()),
    evidenceRunIds: z.array(z.string()),
    reviewIds: z.array(z.string()),
    invalidationReason: z.string().optional(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .strict()
  .meta({ ref: "OrynAttemptResponse" })

const OrynControlInput = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    action: z.enum(["pause", "resume", "takeover", "cancel"]),
  })
  .strict()
  .meta({ ref: "OrynControlInput" })

function handleError(c: Context, error: unknown): Response {
  if (error && typeof error === "object" && "name" in error && error.name === "OrynStoreError") {
    const data = (error as { data?: { code?: string; message?: string; expectedRevision?: number } }).data
    const status = data?.code === "STALE_REVISION" ? 409 : data?.code === "NOT_AUTHORIZED" ? 403 : 409
    return c.json({ message: data?.message ?? "oryn error", code: data?.code ?? "ORYN_ERROR" }, status as 403 | 409)
  }
  return c.json({ message: error instanceof Error ? error.message : "Internal server error" }, 500)
}

function projectListItem(record: {
  id: string
  revision: number
  kind: string
  summary: string
  repoAlias: string
  control: string
  activeAttemptId?: string
  issueNumber?: number
  createdAt: number
  updatedAt: number
}) {
  return {
    id: record.id,
    revision: record.revision,
    kind: record.kind,
    summary: record.summary,
    repoAlias: record.repoAlias,
    control: record.control,
    ...(record.activeAttemptId ? { activeAttemptId: record.activeAttemptId } : {}),
    ...(record.issueNumber !== undefined ? { issueNumber: record.issueNumber } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/**
 * Minimal Oryn case surface. Reads are read-only projections of the store;
 * control is the single write path and is meant for authenticated human
 * operators — model tools never call it. The routes 404/403 when the Oryn
 * runtime is disabled so a dormant installation exposes nothing.
 */
export const OrynRoute = new Hono()
  .get(
    "/cases",
    describeRoute({
      summary: "List Oryn cases",
      description: "List engineering cases with optional repository and control-state filters.",
      operationId: "oryn.case.list",
      responses: {
        200: { description: "Case list", content: { "application/json": { schema: resolver(CaseListResponse) } } },
        ...errors(400),
      },
    }),
    async (c) => {
      if (!(await OrynConfig.enabled())) return c.json({ cases: [] })
      try {
        const repoAlias = c.req.query("repoAlias")
        const control = c.req.query("control")
        const records = await OrynStore.listCases({
          ...(repoAlias ? { repoAlias } : {}),
          ...(control ? { control: control as "active" | "paused" | "human_owned" | "cancelled" | "closed" } : {}),
        })
        return c.json({ cases: records.map(projectListItem) })
      } catch (error) {
        return handleError(c, error)
      }
    },
  )
  .get(
    "/cases/:id",
    describeRoute({
      summary: "Get an Oryn case",
      description: "Return the redacted case record including control state and round counters.",
      operationId: "oryn.case.get",
      responses: {
        200: { description: "Case detail", content: { "application/json": { schema: resolver(CaseDetailResponse) } } },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().min(1) })),
    async (c) => {
      if (!(await OrynConfig.enabled())) return c.json({ message: "oryn is disabled", code: "DISABLED" }, 404)
      try {
        const record = await OrynStore.getCase(c.req.valid("param").id)
        if (!record) return c.json({ message: "case not found", code: "not_found" }, 404)
        return c.json({
          id: record.id,
          revision: record.revision,
          kind: record.kind,
          summary: record.summary,
          ...(record.observed ? { observed: record.observed } : {}),
          ...(record.expected ? { expected: record.expected } : {}),
          repoAlias: record.repoAlias,
          control: record.control,
          acceptanceRevision: record.acceptanceRevision,
          epoch: record.epoch,
          repairRounds: record.repairRounds,
          noProgressRounds: record.noProgressRounds,
          ...(record.activeAttemptId ? { activeAttemptId: record.activeAttemptId } : {}),
          ...(record.issueNumber !== undefined ? { issueNumber: record.issueNumber } : {}),
          pullNumbers: record.pullNumbers,
          sourceCount: record.sourceIds.length,
          humanDecisions: record.humanDecisions,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        })
      } catch (error) {
        return handleError(c, error)
      }
    },
  )
  .get(
    "/cases/:id/attempts/:attemptId",
    describeRoute({
      summary: "Get an Oryn attempt",
      description: "Return one candidate validation cycle with its assignments, runs, and reviews.",
      operationId: "oryn.case.attempt.get",
      responses: {
        200: { description: "Attempt detail", content: { "application/json": { schema: resolver(AttemptResponse) } } },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().min(1), attemptId: z.string().min(1) })),
    async (c) => {
      if (!(await OrynConfig.enabled())) return c.json({ message: "oryn is disabled", code: "DISABLED" }, 404)
      try {
        const { id, attemptId } = c.req.valid("param")
        const attempt = await OrynStore.getAttempt(id, attemptId)
        if (!attempt) return c.json({ message: "attempt not found", code: "not_found" }, 404)
        return c.json({
          id: attempt.id,
          caseId: attempt.caseId,
          revision: attempt.revision,
          baselineSha: attempt.baselineSha,
          ...(attempt.candidateSha ? { candidateSha: attempt.candidateSha } : {}),
          ...(attempt.baseBranchSha ? { baseBranchSha: attempt.baseBranchSha } : {}),
          disposition: attempt.disposition,
          assignmentIds: attempt.assignmentIds,
          evidenceRunIds: attempt.evidenceRunIds,
          reviewIds: attempt.reviewIds,
          ...(attempt.invalidationReason ? { invalidationReason: attempt.invalidationReason } : {}),
          createdAt: attempt.createdAt,
          updatedAt: attempt.updatedAt,
        })
      } catch (error) {
        return handleError(c, error)
      }
    },
  )
  .post(
    "/cases/:id/control",
    describeRoute({
      summary: "Control an Oryn case",
      description:
        "Human operator control transition (pause, resume, takeover, cancel) with compare-and-set on the case revision. Takeover and cancel bump the case epoch so in-flight external actions become stale.",
      operationId: "oryn.case.control",
      responses: {
        200: { description: "Updated case", content: { "application/json": { schema: resolver(CaseDetailResponse) } } },
        ...errors(400, 404, 409),
      },
    }),
    validator("param", z.object({ id: z.string().min(1) })),
    validator("json", OrynControlInput),
    async (c) => {
      if (!(await OrynConfig.enabled())) return c.json({ message: "oryn is disabled", code: "DISABLED" }, 404)
      try {
        const { id } = c.req.valid("param")
        const { expectedRevision, action } = c.req.valid("json")
        const record = await OrynStore.control(id, expectedRevision, action)
        return c.json({
          id: record.id,
          revision: record.revision,
          kind: record.kind,
          summary: record.summary,
          repoAlias: record.repoAlias,
          control: record.control,
          acceptanceRevision: record.acceptanceRevision,
          epoch: record.epoch,
          repairRounds: record.repairRounds,
          noProgressRounds: record.noProgressRounds,
          ...(record.activeAttemptId ? { activeAttemptId: record.activeAttemptId } : {}),
          pullNumbers: record.pullNumbers,
          sourceCount: record.sourceIds.length,
          humanDecisions: record.humanDecisions,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        })
      } catch (error) {
        return handleError(c, error)
      }
    },
  )
