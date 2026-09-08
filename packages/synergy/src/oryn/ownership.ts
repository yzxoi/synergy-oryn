import { Session } from "../session"
import { SessionHistory } from "../session/history"
import { SessionInbox } from "../session/inbox"
import { SessionManager } from "../session/manager"
import { ScopeContext } from "../scope/context"
import { Lock } from "../util/lock"
import { OrynStore, storeError } from "./store"
import type { Case } from "./schema"

export namespace OrynOwnership {
  function deliveryKey(record: Case) {
    return `oryn-ownership:${record.id}:${record.epoch}`
  }

  export async function admitted(record: Case) {
    if (!(await OrynStore.ownershipResume(record.id, record.epoch))) return true
    const sessionID = record.engineeringSessionId
    if (!sessionID) return false
    const key = deliveryKey(record)
    if ((await SessionInbox.list(sessionID)).some((item) => item.deliveryKey === key)) return true
    return (await SessionHistory.messageInfos(sessionID)).some(
      (info) =>
        info.role === "user" &&
        info.isRoot &&
        info.origin?.type === "system" &&
        info.origin.detail === "oryn_ownership" &&
        info.metadata?.inboxDeliveryKey === key,
    )
  }

  export async function prepare(caseId: string) {
    using _lock = await Lock.write(`oryn-case:${caseId}`)
    const record = await OrynStore.getCase(caseId)
    if (!record || record.control !== "active" || (await admitted(record))) return false
    if (!record.engineeringSessionId || !record.activeAttemptId)
      throw storeError("INVALID_STAGE", "Ownership resume has no engineering Session or Attempt")
    const session = await Session.get(record.engineeringSessionId)
    if (session.time.archived || SessionManager.isRunning(session.id))
      throw storeError("INVALID_STAGE", "Ownership resume requires an idle engineering Session")
    const attempt = await OrynStore.getAttempt(caseId, record.activeAttemptId)
    if (!attempt) throw storeError("INVALID_STAGE", "Ownership resume Attempt is missing")
    await ScopeContext.provide({
      scope: session.scope,
      workspace: session.workspace,
      fn: async () => {
        await SessionInbox.removeByMode(session.id, ["task", "steer", "context"])
        await SessionInbox.deliverUnique({
          sessionID: session.id,
          deliveryKey: deliveryKey(record),
          mode: "task",
          message: {
            role: "user",
            agent: "oryn-work",
            origin: { type: "system", detail: "oryn_ownership" },
            metadata: { orynCaseId: caseId, orynAttemptId: attempt.id, orynOwnershipEpoch: record.epoch },
            parts: [
              {
                type: "text",
                origin: "system",
                text: `Human control resumed Oryn case ${caseId} in ownership epoch ${record.epoch}.\nAttempt: ${attempt.id}\nBaseline: ${attempt.baselineSha}\nSummary: ${record.summary}\nObserved: ${record.observed ?? "not supplied"}\nExpected: ${record.expected ?? "clarification required"}\nRead the current Case before dispatch. This is a fresh Attempt; old workers and their queued tasks remain invalidated. Preserve historical evidence for context but obtain current-epoch verification and review. Reconcile existing Issues, PRs and action receipts; do not reuse invalidated request keys or overwrite human changes. Resume does not resolve missing acceptance decisions or unavailable environments. Request human handoff when those gaps remain. Human merge is required.`,
              },
            ],
          },
        })
      },
    })
    return true
  }
}
