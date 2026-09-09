import { RolloutLedger } from "../session/rollout/ledger"
import { Storage } from "../storage/storage"
import { bossAssignmentMetadata } from "../boss/boss-message"
import { ScopeContext } from "../scope/context"
import { Session } from "../session"
import { SessionDrive } from "../session/drive"
import { SessionHistory } from "../session/history"
import { SessionInbox } from "../session/inbox"
import { SessionInvoke } from "../session/invoke"
import { SessionManager } from "../session/manager"
import { SessionProgress } from "../session/progress"
import { Lock } from "../util/lock"
import { OrynControl } from "./control"
import { OrynStore } from "./store"

export namespace OrynResume {
  export async function prepare(
    sessionID: string,
  ): Promise<"idle" | "queued" | "terminal" | "recovered" | "exhausted"> {
    const session = await Session.get(sessionID)
    if (session.time.archived || SessionManager.isRunning(sessionID)) return "idle"
    const binding = await OrynStore.sessionSourceBinding(sessionID)
    if (!binding?.caseId || !["engineering", "worker"].includes(binding.role)) return "idle"
    using _lock = await Lock.tryAcquireWrite(`oryn-case:${binding.caseId}`)
    if (!_lock || SessionManager.isRunning(sessionID) || (await OrynControl.canRun(session)) !== true) return "idle"
    const record = await OrynStore.getCase(binding.caseId)
    const attempt = record?.activeAttemptId && (await OrynStore.getAttempt(record.id, record.activeAttemptId))
    if (!record || !attempt || !["open", "candidate_frozen"].includes(attempt.disposition)) return "idle"
    const assignment =
      binding.role === "worker"
        ? (await OrynStore.listAssignments(record.id)).find((item) => item.sessionId === sessionID)
        : undefined
    if (binding.role === "worker" && (!assignment || assignment.acceptedReportId)) return "idle"
    const queued = await SessionInbox.hasRunnableItem(sessionID)
    const messages = await SessionHistory.modelMessages({ sessionID })
    const root = messages.findLast((item) => item.info.role === "user" && item.info.isRoot === true)
    if (!root || root.info.role !== "user") return queued ? "queued" : "idle"
    if (assignment && bossAssignmentMetadata(root.info, session, { requireRoot: true })?.taskID !== assignment.id)
      return "idle"
    const rollout = await RolloutLedger.getRun(
      { kind: "session", scopeID: session.scope.id, sessionID },
      root.info.id,
    ).catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
    const freshRun = rollout && !["running", "interrupted"].includes(rollout.status)
    if (queued && (!freshRun || (await SessionInbox.peekTask(sessionID)))) return "queued"
    const assistant = messages.findLast((item) => item.info.role === "assistant" && item.info.rootID === root.info.id)
    if (
      !freshRun &&
      assistant?.info.role === "assistant" &&
      !assistant.info.error &&
      SessionProgress.isTerminalAssistant(assistant.info) &&
      !SessionProgress.needsModelCall(messages, root.info.id)
    )
      return "terminal"
    const attempts = (await SessionHistory.messageInfos(sessionID)).filter(
      (info) =>
        info.role === "user" &&
        info.origin?.type === "system" &&
        info.origin.detail === "oryn_resume" &&
        (info.rootID === root.info.id || info.metadata?.orynAttemptId === attempt.id),
    ).length
    if (attempts >= 3) return "exhausted"
    await ScopeContext.provide({
      scope: session.scope,
      workspace: session.workspace,
      fn: () => SessionInvoke.repairAfterAbort(sessionID),
    })
    const repaired = await SessionHistory.messageInfos(sessionID)
    const anchor = repaired.at(-1)?.id ?? root.info.id
    if (SessionManager.isRunning(sessionID)) return "idle"
    await SessionInbox.deliverUnique({
      sessionID,
      deliveryKey: `oryn-resume:${root.info.id}:${anchor}`,
      mode: freshRun ? "task" : "steer",
      message: {
        role: "user",
        origin: { type: "system", detail: "oryn_resume" },
        metadata: {
          ...root.info.metadata,
          source: "oryn_resume",
          orynAttemptId: attempt.id,
          caseId: record.id,
          attemptId: attempt.id,
          assignmentId: assignment?.id,
        },
        summary: { title: "Resume interrupted Oryn task" },
        parts: [
          {
            type: "text",
            origin: "system",
            text: "The previous execution was interrupted. Continue this same task in its existing workspace. Inspect current files, accepted reports and action receipts before deciding what remains. An interrupted tool may already have performed its action; reconcile its result instead of blindly repeating commits or GitHub writes. Preserve completed work and submit the workflow-owned result, or request human help if safe continuation is unavailable.",
          },
        ],
      },
    })
    return "recovered"
  }

  export async function request(sessionID: string) {
    const result = await prepare(sessionID)
    if (result === "queued" || result === "recovered" || result === "terminal")
      await SessionDrive.request(sessionID, "oryn-interrupted-recovery")
    return result
  }
}
