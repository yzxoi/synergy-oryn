import { ToolRegistry } from "../tool/registry"
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
}
