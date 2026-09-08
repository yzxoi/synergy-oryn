import { SessionInbox } from "../session/inbox"
import { SessionManager } from "../session/manager"
import { Lock } from "../util/lock"
import { OrynConfig } from "./config"
import { OrynStore } from "./store"

export namespace OrynReports {
  // Submission and recovery hold the Case control lock through delivery.
  export async function deliverAccepted(caseId: string, assignmentId: string): Promise<boolean> {
    const record = await OrynStore.getCase(caseId)
    const assignment = await OrynStore.getAssignment(caseId, assignmentId)
    if (
      !record?.engineeringSessionId ||
      record.control !== "active" ||
      !assignment?.acceptedReportId ||
      assignment.epoch !== record.epoch ||
      assignment.attemptId !== record.activeAttemptId
    )
      return false
    const attempt = await OrynStore.getAttempt(caseId, assignment.attemptId)
    if (!attempt || ["superseded", "failed", "handed_off", "ready"].includes(attempt.disposition)) return false
    const reportId = assignment.acceptedReportId
    const report =
      assignment.stage === "review"
        ? ((await OrynStore.getReview(caseId, reportId)) ?? (await OrynStore.getWorkerReport(caseId, reportId)))
        : await OrynStore.getWorkerReport(caseId, reportId)
    if (
      !report ||
      report.assignmentId !== assignment.id ||
      report.attemptId !== assignment.attemptId ||
      report.caseId !== caseId
    )
      return false
    const outcome = "recommendation" in report ? report.recommendation : report.outcome
    await SessionInbox.deliverUnique({
      sessionID: record.engineeringSessionId,
      deliveryKey: `oryn-result:${reportId}`,
      mode: "steer",
      message: {
        role: "user",
        origin: { type: "system", detail: "oryn_result" },
        visible: true,
        parts: [
          {
            type: "text",
            text: `Oryn ${assignment.stage} result ${reportId} for assignment ${assignment.id} (attempt ${assignment.attemptId}): ${outcome}. Read the structured report before choosing the next step. Acceptance records receipt of the worker judgment, not verification of its claims.`,
          },
        ],
        metadata: {
          orynCaseId: caseId,
          orynAttemptId: assignment.attemptId,
          orynAssignmentId: assignment.id,
          orynReportId: reportId,
        },
      },
    })
    if (await SessionInbox.hasRunnableItem(record.engineeringSessionId, { allowSteer: true }))
      SessionManager.scheduleWake(record.engineeringSessionId, "oryn_result")
    return true
  }

  export async function recover() {
    if (!(await OrynConfig.enabled())) return { delivered: 0, failed: 0 }
    const result = { delivered: 0, failed: 0 }
    for (const record of await OrynStore.listCases({ control: "active" })) {
      using _lock = await Lock.write(`oryn-case:${record.id}`)
      for (const assignment of await OrynStore.listAssignments(record.id)) {
        if (!assignment.acceptedReportId) continue
        try {
          if (await deliverAccepted(record.id, assignment.id)) result.delivered++
        } catch {
          result.failed++
        }
      }
    }
    return result
  }
}
