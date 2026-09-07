import { ToolRegistry } from "../tool/registry"
import { BossService } from "../boss/boss"
import { OrynStore } from "./store"
import { registerOrynTools } from "./tools"
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

  ToolRegistry.registerToolProvider("oryn", registerOrynTools)
  BossService.registerTaskReportProvider("oryn", async (session, taskID) => {
    if (!["oryn-repro", "oryn-code", "oryn-review"].includes(session.agentOverride ?? "")) return false
    const sessionID = session.id
    const binding = await OrynStore.sessionSourceBinding(sessionID)
    if (binding?.role !== "worker" || !binding.caseId) return false
    const assignment = await OrynStore.getAssignment(binding.caseId, taskID)
    return assignment?.sessionId === sessionID && Boolean(assignment.acceptedReportId)
  })
}
