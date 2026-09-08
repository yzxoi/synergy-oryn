import { SessionRunPolicy } from "../session/run-policy"
import { OrynControl } from "./control"
import { ProcessAccessPolicy } from "../tool/process/policy"
import { BashExecutionPolicy } from "../tool/bash/policy"
import { OrynShell } from "./shell"
import { ToolRegistry } from "../tool/registry"
import { BossService } from "../boss/boss"
import { OrynStore } from "./store"
import { registerOrynTools, CheckParameters, ResultParameters } from "./tools"
import { ToolExecutor } from "../session/tool-executor"
import { OrynExecutor } from "./executor"
import { externalIdentityHash } from "../util/identity"
import "./migration"

/**
 * Oryn domain registration. Loaded through src/product-registration.ts so the
 * storage migration and tool providers are registered before any core
 * registry is consumed.
 *
 * The domain is dormant unless `oryn.enabled` is set: agents, tools, channel
 * routing, and the server routes all check the flag before exposing anything,
 * so an installation without the flag behaves exactly like upstream Synergy.
 * Tools are registered unconditionally (registration is inert metadata) while
 * every tool execution validates the enable flag and caller identity, so a
 * disabled runtime neither leaks tools into agents nor breaks tool-source
 * enumeration for the settings UI.
 */
let registered = false

export function registerOrynDomain(): void {
  if (registered) return
  registered = true
  SessionRunPolicy.register("oryn", OrynControl.canRun)
  BashExecutionPolicy.register("oryn", OrynShell.resolve)
  ProcessAccessPolicy.register("oryn", OrynShell.processAccess)

  ToolRegistry.registerToolProvider("oryn", registerOrynTools)
  ToolExecutor.registerAdmissionProvider("oryn_check", async (input) => {
    const params = CheckParameters.parse((input.input as { input?: unknown } | null)?.input)
    if (params.action !== "run") return { executor: "control_plane" }
    return OrynExecutor.admission({ ...params, callerSessionID: input.sessionID, abort: input.signal })
  })
  ToolExecutor.registerAdmissionProvider("oryn_result", async (input) => {
    const params = ResultParameters.parse((input.input as { input?: unknown } | null)?.input)
    return params.kind === "commit_candidate"
      ? { executor: "local_process", resources: [{ key: `oryn:commit:${params.caseId}`, limit: 1 }] }
      : { executor: "control_plane" }
  })
  BossService.registerTaskReportProvider("oryn", async (session, taskID) => {
    if (!["oryn-repro", "oryn-code", "oryn-review"].includes(session.agentOverride ?? "")) return undefined
    const sessionID = session.id
    const binding = await OrynStore.sessionSourceBinding(sessionID)
    if (binding?.role !== "worker" || !binding.caseId) return false
    const assignment = await OrynStore.getAssignment(binding.caseId, taskID)
    if (!assignment || assignment.sessionId !== sessionID) return false
    const record = await OrynStore.getCase(binding.caseId)
    if (
      !record ||
      record.control !== "active" ||
      record.epoch !== assignment.epoch ||
      record.activeAttemptId !== assignment.attemptId
    )
      return true
    const attempt = await OrynStore.getAttempt(binding.caseId, assignment.attemptId)
    if (!attempt || ["superseded", "failed", "handed_off", "ready"].includes(attempt.disposition)) return true
    if (
      assignment.stage === "review" &&
      assignment.frozenInputsDigest !==
        externalIdentityHash(attempt.baselineSha, attempt.candidateSha ?? "", record.acceptanceDigest, "review")
    )
      return true
    if (assignment.stage === "review")
      return Boolean(
        assignment.acceptedReportId && (await OrynStore.getReview(binding.caseId, assignment.acceptedReportId)),
      )
    return Boolean(assignment.acceptedReportId)
  })
}
