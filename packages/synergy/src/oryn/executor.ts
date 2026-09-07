import { realpath } from "node:fs/promises"
import { Session } from "../session"
import { SandboxBackend } from "../sandbox/backend"
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

const CHILD_ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "SHELL"]

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

/** Process-level lanes: model pool admission stays with the runtime scheduler. */
const lanes = new Map<string, number>()
const waiters: Array<() => void> = []

async function acquire(key: string, max: number): Promise<void> {
  for (;;) {
    const running = lanes.get(key) ?? 0
    if (running < max) {
      lanes.set(key, running + 1)
      return
    }
    await new Promise<void>((resolve) => waiters.push(resolve))
  }
}

function release(key: string): void {
  const running = (lanes.get(key) ?? 1) - 1
  if (running <= 0) lanes.delete(key)
  else lanes.set(key, running)
  const next = waiters.shift()
  if (next) next()
}

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
  startedAt: number
  endedAt: number
  observations: string[]
}

async function runOne(argv: string[], cwd: string, timeoutSeconds: number, abort: AbortSignal): Promise<RunOneResult> {
  const startedAt = Date.now()
  const result = await SandboxBackend.executeAsync(
    { command: argv[0], args: argv.slice(1), sandboxed: false },
    {
      cwd,
      env: childEnv(),
      inheritEnv: false,
      fallbackPolicy: "allow",
      signal: abort,
      timeoutMs: timeoutSeconds * 1000,
      maxOutputBytes: 64 * 1024,
    },
  )
  return {
    argv,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    aborted: abort.aborted,
    truncated: result.truncated,
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

    await OrynStore.mutateCheckPlan(input.caseId, input.planId, (draft) => ({ ...draft, status: "approved" }))

    const concurrencyKey = `oryn-profile:${plan.profileId}`
    const globalHeavyKey = "oryn-heavy"
    const heavyMax = Math.max(1, limits?.heavyConcurrency ?? 2)
    const profileMax = Math.max(1, profile.maxConcurrent ?? 1)
    // Global heavy lane is acquired before the profile lane everywhere, so
    // the nested wait cannot deadlock; both wake FIFO.
    await acquire(globalHeavyKey, heavyMax)
    let acquired = false
    try {
      await acquire(concurrencyKey, profileMax)
      acquired = true

      const expectedSha = await currentInputs()
      const before = await OrynGit.snapshot(cwd)
      if (before.sha !== expectedSha || before.dirty)
        throw storeError("INVALID_STAGE", "check workspace does not match its clean fixed commit")
      const timeoutSeconds = profile.timeoutSeconds ?? 1800
      const results: RunOneResult[] = []
      for (const command of plan.argv) {
        await currentInputs()
        const result = await runOne(command, cwd, timeoutSeconds, input.abort)
        results.push(result)
        if (result.timedOut || result.aborted || result.truncated) break
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
      const failed = results.some((r) => r.exitCode !== 0)
      const outcome: RunReceipt["outcome"] = aborted
        ? "cancelled"
        : timedOut || truncated || changed || !active
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
        infrastructureFailure: timedOut || truncated || changed || !active,
      })
      await OrynStore.attachRunEvidence(input.caseId, input.attemptId, receipt.id)
      return { runId: receipt.id, outcome, overlayApplied: plan.overlay }
    } finally {
      if (acquired) release(concurrencyKey)
      release(globalHeavyKey)
    }
  }
}
