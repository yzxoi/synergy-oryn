import { OrynGithubStore } from "./github-store"
import { OrynGithub } from "./github"
import { isOrynAgent } from "../agent/builtin-oryn"
import { ProcessRegistry } from "../process/registry"
import type { Session } from "../session"
import { SessionDrive } from "../session/drive"
import { SessionInvoke } from "../session/invoke"
import { SessionManager } from "../session/manager"
import { ToolScheduler } from "../session/tool-scheduler"
import { Lock } from "../util/lock"
import { Log } from "../util/log"
import { OrynOwnership } from "./ownership"
import { OrynEvidence } from "./evidence"
import { OrynBudget } from "./budget"
import { OrynConfig } from "./config"
import { OrynStore, storeError } from "./store"
import type { Case } from "./schema"

export namespace OrynControl {
  export async function canRun(session: Session.Info): Promise<boolean | undefined> {
    const binding = await OrynStore.sessionSourceBinding(session.id)
    if (!binding) return isOrynAgent(session.agentOverride ?? "") ? false : undefined
    if (binding.role === "qa") return undefined
    if (!binding.caseId || !(await OrynConfig.enabled())) return false
    const record = await OrynStore.getCase(binding.caseId)
    if (!record || record.control !== "active") return false
    const github = await OrynGithubStore.get(record.id)
    if (
      github &&
      ((github.mode === "review" &&
        github.attemptFingerprint !== undefined &&
        github.attemptFingerprint !== github.fingerprint) ||
        ["settled", "waiting_author"].includes(github.state) ||
        !(await OrynGithub.authorized(github, "run")))
    )
      return false
    if (await OrynBudget.reason(record)) return false
    if (binding.role === "engineering")
      return (
        record.engineeringSessionId === session.id &&
        session.agentOverride === "oryn-work" &&
        (await OrynOwnership.admitted(record))
      )
    if (binding.role !== "worker") return false
    const assignment = (await OrynStore.listAssignments(record.id)).find((item) => item.sessionId === session.id)
    if (
      !assignment ||
      assignment.agentId !== session.agentOverride ||
      assignment.epoch !== record.epoch ||
      assignment.attemptId !== record.activeAttemptId
    )
      return false
    const attempt = await OrynStore.getAttempt(record.id, assignment.attemptId)
    if (
      attempt &&
      assignment.stage === "review" &&
      assignment.frozenInputsDigest !== OrynEvidence.assignmentDigest(record, attempt, "review")
    )
      return false
    return !!attempt && ["open", "candidate_frozen"].includes(attempt.disposition)
  }

  async function sessions(record: Case) {
    const assignments = await OrynStore.listAssignments(record.id)
    const ids = new Set([
      ...(record.engineeringSessionId ? [record.engineeringSessionId] : []),
      ...assignments.flatMap((item) => (item.sessionId ? [item.sessionId] : [])),
    ])
    const owned: string[] = []
    for (const id of ids) {
      const binding = await OrynStore.sessionSourceBinding(id)
      if (!binding) continue
      if (binding.caseId !== record.id || !["engineering", "worker"].includes(binding.role))
        throw storeError("NOT_AUTHORIZED", "Case execution binding differs from its recorded Session")
      owned.push(id)
    }
    return owned
  }

  async function stop(record: Case, callerSessionID = ToolScheduler.currentExecution()?.sessionID) {
    const owned = await sessions(record)
    const stopping = owned.filter((id) => id !== callerSessionID)
    for (const id of stopping) SessionInvoke.cancel(id, { recoverQueuedTasks: false })
    await Promise.all(stopping.map((id) => SessionManager.drain(id)))
    const processes = ProcessRegistry.listAll().filter(
      (proc): proc is ProcessRegistry.Process => "exited" in proc && !!proc.sessionID && owned.includes(proc.sessionID),
    )
    await Promise.all(
      processes.map(async (proc) => {
        await ProcessRegistry.terminate(proc, { allowExitedParent: true })
        await ProcessRegistry.completion(proc)
      }),
    )
  }

  export async function change(input: {
    caseId: string
    expectedRevision: number
    action: "pause" | "resume" | "takeover" | "cancel"
  }) {
    let record: Case
    {
      using _lock = await Lock.tryAcquireWrite(`oryn-control:${input.caseId}`)
      if (!_lock) throw storeError("INVALID_STAGE", "Case control is in progress; retry after cleanup")
      record = await OrynStore.control(input.caseId, input.expectedRevision, input.action)
      if (record.control === "active") {
        for (const id of await sessions(record)) await SessionDrive.request(id, "oryn-resume")
      } else await stop(record)
    }
    if (input.action === "resume") {
      const { OrynService } = await import("./service")
      await OrynService.recoverWorkers({ caseId: input.caseId })
      await OrynService.recoverEngineeringTurns({ caseId: input.caseId })
      record = (await OrynStore.getCase(input.caseId)) ?? record
    }
    return record
  }

  export async function handoff(input: { caseId: string; reason: string; callerSessionID: string }) {
    using _lock = await Lock.tryAcquireWrite(`oryn-control:${input.caseId}`)
    if (!_lock) throw storeError("INVALID_STAGE", "Case control is in progress; retry after cleanup")
    const record = await OrynStore.requestHandoff(input.caseId, input.reason)
    await stop(record)
    return record
  }

  export async function recover() {
    const result = { recovered: 0, failed: 0 }
    if (!(await OrynConfig.enabled())) return result
    for (const item of await OrynStore.listCases()) {
      if (item.control === "active") continue
      using _lock = await Lock.tryAcquireWrite(`oryn-control:${item.id}`)
      if (!_lock) continue
      const record = await OrynStore.getCase(item.id)
      if (!record || record.control === "active") continue
      try {
        await stop(record)
        result.recovered++
      } catch (error) {
        result.failed++
        Log.create({ service: "oryn.control" }).warn("Case process cleanup incomplete", { caseId: item.id, error })
      }
    }
    return result
  }

  export async function enforceBudgets() {
    const result = { expired: 0, failed: 0 }
    if (!(await OrynConfig.enabled())) return result
    for (const item of await OrynStore.listCases({ control: "active" })) {
      try {
        using lock = await Lock.tryAcquireWrite(`oryn-control:${item.id}`)
        if (!lock) continue
        const current = await OrynStore.getCase(item.id)
        if (!current) continue
        const attempt = current.activeAttemptId
          ? await OrynStore.getAttempt(current.id, current.activeAttemptId)
          : undefined
        const reason = await OrynBudget.reason(current)
        if (!reason) continue
        const record = await OrynStore.requestHandoff(current.id, reason, {
          revision: current.revision,
          attemptRevision: attempt?.revision,
        })
        if (record.control !== "human_owned" || record.handoff?.reason !== reason) continue
        result.expired++
        await stop(record)
      } catch (error) {
        result.failed++
        Log.create({ service: "oryn.control" }).warn("Case budget enforcement incomplete", { caseId: item.id, error })
      }
    }
    return result
  }
}
