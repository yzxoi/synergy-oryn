import { realpath } from "node:fs/promises"
import { Session } from "../session"
import { ToolScheduler } from "../session/tool-scheduler"
import { OrynSandbox } from "./sandbox"
import { EnforcementError } from "../enforcement/errors"
import type { OrynExecutionProfile } from "../config/schema"
import { OrynGit } from "./git"
import { externalIdentityHash } from "../util/identity"
import { OrynStore, storeError } from "./store"
import { OrynConfig } from "./config"
import type { CheckPlan, RunReceipt } from "./schema"

/**
 * Host-side check runner with assignment, profile and version validation.
 * Receipts describe observed execution; inherited environment filtering and
 * Git snapshots do not provide process containment or prove behavior coverage.
 */

function digestPlan(plan: CheckPlan): string {
  return externalIdentityHash(
    plan.id,
    plan.scenario,
    plan.profileId,
    JSON.stringify(plan.argv),
    JSON.stringify(plan.checks),
  )
}

type RunOneResult = {
  argv: string[]
  exitCode: number
  timedOut: boolean
  aborted: boolean
  truncated: boolean
  blocked: boolean
  startedAt: number
  endedAt: number
  observations: string[]
}

async function runOne(
  argv: string[],
  cwd: string,
  timeoutSeconds: number,
  abort: AbortSignal,
  profile: OrynExecutionProfile,
): Promise<RunOneResult> {
  const startedAt = Date.now()
  let blocked = false
  const result = await ToolScheduler.trackPhysicalExecution(() =>
    OrynSandbox.execute({ argv, cwd, timeoutMs: timeoutSeconds * 1000, abort, profile }),
  ).catch((error) => {
    if (!(error instanceof EnforcementError.SandboxBlocked)) throw error
    blocked = true
    return {
      exitCode: error.exitCode ?? 1,
      stdout: "",
      stderr: "sandbox denied check access; environment is insufficient",
      timedOut: false,
      truncated: false,
    }
  })
  return {
    argv,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    aborted: abort.aborted,
    truncated: result.truncated,
    blocked,
    startedAt,
    endedAt: Date.now(),
    observations: [
      ...(result.truncated ? ["process output truncated; evidence is inconclusive"] : []),
      ...(result.stdout ? [`stdout: ${result.stdout.slice(0, 2000)}`] : []),
      ...(result.stderr ? [`stderr: ${result.stderr.slice(0, 2000)}`] : []),
    ],
  }
}

export namespace OrynExecutor {
  export async function admission(input: {
    callerSessionID: string
    caseId: string
    assignmentId: string
    attemptId: string
    planId: string
    abort: AbortSignal
  }) {
    input.abort.throwIfAborted()
    const binding = await OrynStore.sessionSourceBinding(input.callerSessionID)
    if (binding?.role !== "worker" || binding.caseId !== input.caseId)
      throw storeError("NOT_AUTHORIZED", "only the bound worker can request check resources")
    const [assignment, plan, oryn] = await Promise.all([
      OrynStore.getAssignment(input.caseId, input.assignmentId),
      OrynStore.getCheckPlan(input.caseId, input.planId),
      OrynConfig.info(),
    ])
    if (!oryn?.enabled) throw storeError("NOT_AUTHORIZED", "Oryn is disabled")
    if (
      !assignment ||
      assignment.sessionId !== input.callerSessionID ||
      assignment.attemptId !== input.attemptId ||
      plan?.attemptId !== input.attemptId
    )
      throw storeError("NOT_AUTHORIZED", "check admission requires matching worker and plan")
    const profile = oryn.executionProfiles?.[plan.profileId]
    if (!profile) throw storeError("ENVIRONMENT_UNAVAILABLE", "check profile is unavailable")
    return {
      executor: "local_process" as const,
      resources: [
        { key: "oryn:heavy", limit: oryn.limits?.heavyConcurrency ?? 2 },
        { key: `oryn:profile:${plan.profileId}`, limit: profile.maxConcurrent ?? 1 },
      ],
    }
  }

  /**
   * Run an approved check plan. Admission: caller is a bound worker whose
   * assignment matches, profile exists with every argv[0] allowlisted, and
   * the case time budget is not exhausted. The plan is host-approved on this
   * validation and the receipt is written by the executor only.
   */
  export async function run(input: {
    callerSessionID: string
    caseId: string
    attemptId: string
    assignmentId: string
    planId: string
    lane: RunReceipt["lane"]
    abort: AbortSignal
  }): Promise<{ runId: string; outcome: RunReceipt["outcome"]; overlayApplied: boolean }> {
    const binding = await OrynStore.sessionSourceBinding(input.callerSessionID)
    if (!binding) throw storeError("NOT_AUTHORIZED", "session has no Oryn source binding")
    if (binding.role !== "worker") throw storeError("NOT_AUTHORIZED", "only worker sessions can execute check runs")
    if (binding.caseId !== input.caseId) throw storeError("NOT_AUTHORIZED", "case does not belong to this session")

    const assignment = await OrynStore.getAssignment(input.caseId, input.assignmentId)
    if (!assignment) throw storeError("NOT_AUTHORIZED", `assignment ${input.assignmentId} not found`)
    if (assignment.sessionId !== input.callerSessionID) {
      throw storeError("NOT_AUTHORIZED", "assignment does not belong to this session")
    }
    if (assignment.attemptId !== input.attemptId) {
      throw storeError("INVALID_STAGE", "assignment belongs to a different attempt")
    }

    const session = await Session.get(input.callerSessionID)
    if (session.workspace?.type !== "git_worktree" || !assignment.workspaceRef)
      throw storeError("ENVIRONMENT_UNAVAILABLE", "check requires the assigned version-pinned worktree")
    const cwd = await realpath(session.workspace.path)
    if (cwd !== (await realpath(assignment.workspaceRef)))
      throw storeError("NOT_AUTHORIZED", "check workspace binding changed")

    const currentInputs = async () => {
      input.abort.throwIfAborted()
      if (!(await OrynConfig.enabled())) throw storeError("NOT_AUTHORIZED", "Oryn is disabled")
      const [record, attempt] = await Promise.all([
        OrynStore.getCase(input.caseId),
        OrynStore.getAttempt(input.caseId, input.attemptId),
      ])
      if (
        !record ||
        record.control !== "active" ||
        record.epoch !== assignment.epoch ||
        record.activeAttemptId !== input.attemptId
      )
        throw storeError("HUMAN_OWNED", "check assignment is no longer active")
      if (!attempt || ["superseded", "failed", "handed_off", "ready"].includes(attempt.disposition))
        throw storeError("INVALID_STAGE", "check Attempt is no longer active")
      const sha =
        input.lane === "candidate"
          ? attempt.candidateSha
          : assignment.stage === "review" || assignment.stage === "verify"
            ? attempt.candidateSha
            : attempt.baselineSha
      const expectedSha = input.lane === "baseline" ? attempt.baselineSha : sha
      if (!expectedSha) throw storeError("INVALID_STAGE", "check lane has no fixed commit")
      return expectedSha
    }

    const plan = await OrynStore.getCheckPlan(input.caseId, input.planId)
    if (!plan) throw storeError("NOT_AUTHORIZED", `check plan ${input.planId} not found`)
    if (plan.attemptId !== input.attemptId) {
      throw storeError("INVALID_STAGE", "check plan belongs to a different attempt")
    }

    const oryn = await OrynConfig.info()
    const profile = oryn?.executionProfiles?.[plan.profileId]
    if (!profile) {
      throw storeError("ENVIRONMENT_UNAVAILABLE", `execution profile "${plan.profileId}" is not configured`)
    }
    for (const command of plan.argv) {
      if (!profile.commandAllowlist.includes(command[0])) {
        throw storeError(
          "ENVIRONMENT_UNAVAILABLE",
          `command "${command[0]}" is not allowlisted by profile "${plan.profileId}"`,
        )
      }
    }

    const limits = oryn?.limits
    const budget = await OrynStore.checkBudget(input.caseId)
    const maxMinutes = limits?.maxCaseMinutes
    if (maxMinutes !== undefined && budget.elapsedMinutes > maxMinutes) {
      throw storeError("BUDGET_EXHAUSTED", `case exceeded ${maxMinutes} minutes`)
    }

    const admission = await OrynExecutor.admission(input)
    const lease = ToolScheduler.currentExecution()
    if (
      lease?.sessionID !== input.callerSessionID ||
      lease.executor !== admission.executor ||
      admission.resources.some(
        (resource) => !lease.resources.some((held) => held.key === resource.key && held.limit === resource.limit),
      )
    )
      throw storeError("NOT_AUTHORIZED", "check requires current scheduler admission for its configured resources")

    const expectedSha = await currentInputs()
    await OrynStore.mutateCheckPlan(input.caseId, input.planId, (draft) => ({ ...draft, status: "approved" }))
    const before = await OrynGit.snapshot(cwd)
    if (before.sha !== expectedSha || before.dirty)
      throw storeError("INVALID_STAGE", "check workspace does not match its clean fixed commit")
    const timeoutSeconds = profile.timeoutSeconds ?? 1800
    const results: RunOneResult[] = []
    for (const command of plan.argv) {
      await currentInputs()
      const result = await runOne(command, cwd, timeoutSeconds, input.abort, profile)
      results.push(result)
      if (result.timedOut || result.aborted || result.truncated || result.blocked) break
    }

    const after = await OrynGit.snapshot(cwd).catch(() => undefined)
    const changed = !after || after.sha !== before.sha || after.tree !== before.tree || after.dirty
    const active = await currentInputs().then(
      (sha) => sha === expectedSha,
      () => false,
    )
    const timedOut = results.some((r) => r.timedOut)
    const aborted = results.some((r) => r.aborted)
    const truncated = results.some((r) => r.truncated)
    const blocked = results.some((r) => r.blocked)
    const failed = results.some((r) => r.exitCode !== 0)
    const outcome: RunReceipt["outcome"] = aborted
      ? "cancelled"
      : timedOut || truncated || blocked || changed || !active
        ? "inconclusive"
        : failed
          ? "failed"
          : "passed"

    const receipt = await OrynStore.writeRunReceipt({
      assignmentId: input.assignmentId,
      caseId: input.caseId,
      attemptId: input.attemptId,
      planDigest: digestPlan(plan),
      lane: input.lane,
      actualSha: before.sha,
      treeDigest: before.tree,
      profile: plan.profileId,
      argvSummary: plan.argv
        .map((command) => command.join(" "))
        .join(" && ")
        .slice(0, 2000),
      startedAt: results[0].startedAt,
      endedAt: results[results.length - 1].endedAt,
      exitCode: results[results.length - 1].exitCode,
      observations: [
        ...(changed ? ["source changed during execution; evidence is inconclusive"] : []),
        ...(!active ? ["assignment inputs or control changed during execution; evidence is inconclusive"] : []),
        ...results.flatMap((r) => r.observations),
      ].slice(0, 64),
      authenticity: "built_runtime",
      outcome,
      overlayApplied: plan.overlay,
      infrastructureFailure: timedOut || truncated || blocked || changed || !active,
    })
    await OrynStore.attachRunEvidence(input.caseId, input.attemptId, receipt.id)
    return { runId: receipt.id, outcome, overlayApplied: plan.overlay }
  }
}
