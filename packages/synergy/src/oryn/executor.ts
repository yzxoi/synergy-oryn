import { $ } from "bun"
import { externalIdentityHash } from "../util/identity"
import { OrynStore, storeError } from "./store"
import { OrynConfig } from "./config"
import type { CheckPlan, RunReceipt } from "./schema"

/**
 * Trusted check executor. This is the only component that writes RunReceipt
 * records: worker models propose plans and reference receipts, but the run
 * itself — command validation against the profile allowlist, concurrency
 * limits, timeout, environment — happens here, host-side, so a receipt is
 * evidence rather than a claim.
 *
 * The child environment is a minimal allowlist. GitHub/SSH credentials are
 * structurally absent: a receipt-producing run can never read the token even
 * through curl or helper scripts, matching the worker bash strip.
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
  startedAt: number
  endedAt: number
  observations: string[]
}

async function runOne(argv: string[], cwd: string, timeoutSeconds: number, abort: AbortSignal): Promise<RunOneResult> {
  const startedAt = Date.now()
  const child = Bun.spawn(argv, {
    cwd,
    env: childEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill(9)
  }, timeoutSeconds * 1000)
  const onAbort = () => child.kill(9)
  abort.addEventListener("abort", onAbort, { once: true })
  const output = await new Response(child.stdout).text()
  const stderr = await new Response(child.stderr).text()
  const exitCode = await child.exited
  clearTimeout(timer)
  abort.removeEventListener("abort", onAbort)
  return {
    argv,
    exitCode,
    timedOut,
    aborted: abort.aborted,
    startedAt,
    endedAt: Date.now(),
    observations: [
      ...(output ? [`stdout: ${output.slice(0, 2000)}`] : []),
      ...(stderr ? [`stderr: ${stderr.slice(0, 2000)}`] : []),
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
    cwd: string
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

      const timeoutSeconds = profile.timeoutSeconds ?? 1800
      const results: RunOneResult[] = []
      for (const command of plan.argv) {
        results.push(await runOne(command, input.cwd, timeoutSeconds, input.abort))
      }

      const timedOut = results.some((r) => r.timedOut)
      const aborted = results.some((r) => r.aborted)
      const failed = results.some((r) => r.exitCode !== 0)
      const outcome: RunReceipt["outcome"] = aborted
        ? "cancelled"
        : timedOut
          ? "inconclusive"
          : failed
            ? "failed"
            : "passed"

      const actualSha = await $`git rev-parse HEAD`
        .quiet()
        .nothrow()
        .cwd(input.cwd)
        .text()
        .then((s) => s.trim() || undefined)
      const treeDigest = await $`git log -1 --format=%T`
        .quiet()
        .nothrow()
        .cwd(input.cwd)
        .text()
        .then((s) => s.trim() || undefined)

      const receipt = await OrynStore.writeRunReceipt({
        assignmentId: input.assignmentId,
        caseId: input.caseId,
        attemptId: input.attemptId,
        planDigest: digestPlan(plan),
        lane: input.lane,
        actualSha,
        treeDigest,
        profile: plan.profileId,
        argvSummary: plan.argv
          .map((command) => command.join(" "))
          .join(" && ")
          .slice(0, 2000),
        startedAt: results[0].startedAt,
        endedAt: results[results.length - 1].endedAt,
        exitCode: results[results.length - 1].exitCode,
        observations: results.flatMap((r) => r.observations).slice(0, 64),
        authenticity: "built_runtime",
        outcome,
        overlayApplied: plan.overlay,
        infrastructureFailure: timedOut,
      })
      await OrynStore.attachRunEvidence(input.caseId, input.attemptId, receipt.id)
      return { runId: receipt.id, outcome, overlayApplied: plan.overlay }
    } finally {
      if (acquired) release(concurrencyKey)
      release(globalHeavyKey)
    }
  }
}
