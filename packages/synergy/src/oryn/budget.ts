import { z } from "zod"
import { Storage } from "../storage/storage"
import { OrynDiscovery } from "./discovery"
import { OrynConfig } from "./config"
import { OrynPath } from "./path"
import type { Case } from "./schema"
import { OrynStore, storeError } from "./store"
import { Lock } from "../util/lock"

const Execution = z
  .object({ schemaVersion: z.literal(1), step: z.string(), elapsedMs: z.number().nonnegative(), updatedAt: z.number() })
  .strict()

export namespace OrynBudget {
  const active = new Map<
    string,
    { write: () => Promise<void>; retain: () => { [Symbol.asyncDispose](): Promise<void> } }
  >()

  export async function record(input: { caseId: string; step: string; executionId: string; elapsedMs: number }) {
    const key = OrynPath.execution(input.caseId, input.executionId)
    using lock = await Lock.write(`oryn-execution:${input.caseId}:${input.executionId}`)
    const previous = await Storage.read(key).then(
      (value) => Execution.parse(value),
      (error) => {
        if (error instanceof Storage.NotFoundError) return undefined
        throw error
      },
    )
    if (previous && previous.step !== input.step) throw storeError("INVALID_STAGE", "Execution step identity changed")
    await Storage.write(
      key,
      Execution.parse({
        schemaVersion: 1,
        step: input.step,
        elapsedMs: Math.max(previous?.elapsedMs ?? 0, input.elapsedMs),
        updatedAt: Date.now(),
      }),
    )
  }

  export async function steps(caseId: string) {
    const groups = new Map<string, number>()
    for (const id of await Storage.scan(OrynPath.executionsRoot(caseId))) {
      const item = Execution.parse(await Storage.read(OrynPath.execution(caseId, id)))
      groups.set(item.step, (groups.get(item.step) ?? 0) + item.elapsedMs)
    }
    return [...groups].map(([step, elapsedMs]) => ({ step, elapsedMs }))
  }

  export async function checkpoint() {
    await Promise.all([...active.values()].map((entry) => entry.write()))
  }

  export async function begin(sessionID: string) {
    const binding = await OrynStore.sessionSourceBinding(sessionID)
    if (!binding?.caseId || !["engineering", "worker"].includes(binding.role)) return
    const current = await OrynStore.getCase(binding.caseId)
    if (!current?.activeAttemptId || current.control !== "active") return
    await assert(current)
    const assignment =
      binding.role === "worker"
        ? (await OrynStore.listAssignments(current.id)).find(
            (item) =>
              item.sessionId === sessionID &&
              item.attemptId === current.activeAttemptId &&
              item.epoch === current.epoch,
          )
        : undefined
    if (binding.role === "worker" && !assignment) return
    const attempt = await OrynStore.getAttempt(current.id, current.activeAttemptId)
    const stage = assignment
      ? `${assignment.stage}:${assignment.reviewDomain ?? "general"}`
      : attempt?.candidateSha
        ? "prepare"
        : "triage"
    const step = `${attempt?.budgetAttemptId ?? current.activeAttemptId}:${stage}`
    const activeKey = `${current.id}:${step}`
    using lock = await Lock.write(`oryn-meter:${activeKey}`)
    const existing = active.get(activeKey)
    if (existing) return existing.retain()
    const executionId = crypto.randomUUID()
    const started = performance.now()
    let closed = false
    let last = 0
    const write = async (force = false) => {
      const elapsedMs = performance.now() - started
      if (!force && (closed || elapsedMs - last < 15_000)) return
      last = elapsedMs
      await record({ caseId: current.id, step, executionId, elapsedMs })
    }
    await record({ caseId: current.id, step, executionId, elapsedMs: 0 })
    let references = 0
    const retain = () => {
      references++
      let released = false
      return {
        async [Symbol.asyncDispose]() {
          if (released) return
          released = true
          if (--references > 0) return
          closed = true
          active.delete(activeKey)
          await write(true)
        },
      }
    }
    active.set(activeKey, { write, retain })
    return retain()
  }

  export async function reason(record: Case) {
    const config = await OrynConfig.info()
    if (!config?.enabled || record.control !== "active") return
    if (record.activeAttemptId) {
      const attempt = await OrynStore.getAttempt(record.id, record.activeAttemptId)
      if (attempt?.disposition === "ready") return
    }
    const lineage = await OrynDiscovery.lineage(record.id)
    const root = lineage ? await OrynStore.getCase(lineage.rootCaseId) : record
    if (root && root.control !== "active" && root.control !== "closed")
      return "The root Case requires human attention before descendant work can continue."
    const minutes = config.limits?.maxStepMinutes ?? 360
    const budgetAttempt = record.activeAttemptId
      ? ((await OrynStore.getAttempt(record.id, record.activeAttemptId))?.budgetAttemptId ?? record.activeAttemptId)
      : undefined
    const exhausted = (await steps(record.id)).find(
      (item) => (!budgetAttempt || item.step.startsWith(`${budgetAttempt}:`)) && item.elapsedMs >= minutes * 60_000,
    )
    if (exhausted)
      return `Step execution budget of ${minutes} minutes is exhausted; a human must review the retained work and increase the budget before resuming.`
  }

  export async function assert(record: Case) {
    const message = await reason(record)
    if (message) throw storeError("BUDGET_EXHAUSTED", message, { caseId: record.id })
  }
}
