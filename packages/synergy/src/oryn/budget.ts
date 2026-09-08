import { OrynConfig } from "./config"
import type { Case } from "./schema"
import { OrynStore, storeError } from "./store"

export namespace OrynBudget {
  export async function reason(record: Case) {
    const config = await OrynConfig.info()
    if (!config?.enabled || record.control !== "active") return
    if (record.activeAttemptId) {
      const attempt = await OrynStore.getAttempt(record.id, record.activeAttemptId)
      if (attempt?.disposition === "ready") return
    }
    const minutes = config.limits?.maxCaseMinutes ?? 720
    if (Date.now() - record.createdAt >= minutes * 60_000)
      return `Case wall-clock budget of ${minutes} minutes is exhausted; a human must review the retained work and increase the budget before resuming.`
  }

  export async function assert(record: Case) {
    const message = await reason(record)
    if (message) throw storeError("BUDGET_EXHAUSTED", message, { caseId: record.id })
  }
}
