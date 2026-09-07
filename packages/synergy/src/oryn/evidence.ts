import { externalIdentityHash } from "../util/identity"
import type { Assignment, Attempt, CheckPlan, RunReceipt, WorkerReport } from "./schema"
import { OrynStore, storeError } from "./store"

export namespace OrynEvidence {
  export function planDigest(plan: CheckPlan): string {
    return externalIdentityHash(
      plan.id,
      plan.scenario,
      plan.profileId,
      JSON.stringify(plan.argv),
      JSON.stringify(plan.checks),
    )
  }

  export async function reportRuns(input: {
    assignment: Assignment
    attempt: Attempt
    report: Pick<WorkerReport, "kind" | "outcome" | "runIds">
  }): Promise<RunReceipt[]> {
    const { assignment, attempt, report } = input
    const plans = await OrynStore.listCheckPlans(assignment.caseId)
    const runs: RunReceipt[] = []
    for (const id of new Set(report.runIds)) {
      const run = await OrynStore.getRun(assignment.caseId, id)
      if (
        !run ||
        run.id !== id ||
        run.caseId !== assignment.caseId ||
        run.attemptId !== attempt.id ||
        run.assignmentId !== assignment.id
      )
        throw storeError("EVIDENCE_INSUFFICIENT", "run evidence must belong to the reporting assignment")
      const plan = plans.find((plan) => planDigest(plan) === run.planDigest)
      if (
        !plan ||
        plan.caseId !== assignment.caseId ||
        plan.attemptId !== attempt.id ||
        plan.status !== "approved" ||
        plan.profileId !== run.profile ||
        plan.overlay !== run.overlayApplied
      )
        throw storeError("EVIDENCE_INSUFFICIENT", "run evidence does not match its current approved plan")
      const expectedSha =
        run.lane === "baseline"
          ? attempt.baselineSha
          : run.lane === "candidate" || assignment.stage === "verify" || assignment.stage === "review"
            ? attempt.candidateSha
            : attempt.baselineSha
      if (!expectedSha || run.actualSha !== expectedSha || !run.treeDigest)
        throw storeError("EVIDENCE_INSUFFICIENT", "run evidence does not match the assigned source version")
      runs.push(run)
    }
    const proves = (lane: RunReceipt["lane"], outcome: RunReceipt["outcome"]) =>
      runs.some(
        (run) => run.lane === lane && run.outcome === outcome && !run.infrastructureFailure && !run.overlayApplied,
      )
    if (report.kind === "repro" && report.outcome === "reproduced" && !proves("baseline", "failed"))
      throw storeError("EVIDENCE_INSUFFICIENT", "reproduced requires this worker's failing baseline run")
    if (report.kind === "repro" && report.outcome === "already_fixed" && !proves("baseline", "passed"))
      throw storeError("EVIDENCE_INSUFFICIENT", "already_fixed requires this worker's passing baseline run")
    if (
      report.kind === "verification" &&
      ["verified", "passed"].includes(report.outcome) &&
      !proves("candidate", "passed")
    )
      throw storeError("EVIDENCE_INSUFFICIENT", "verified requires this verifier's clean passing candidate run")
    return runs
  }
}
