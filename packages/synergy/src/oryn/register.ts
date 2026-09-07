import { Config } from "../config/config"
import "./migration"

/**
 * Oryn domain registration. Loaded through src/product-registration.ts so the
 * storage migration is registered before any core registry is consumed.
 *
 * The domain is dormant unless `oryn.enabled` is set: agents, tools, channel
 * routing, and the server routes all check the flag before exposing anything,
 * so an installation without the flag behaves exactly like upstream Synergy.
 */
let registered = false

export function registerOrynDomain(): void {
  if (registered) return
  registered = true
}

export namespace OrynConfig {
  export async function enabled(): Promise<boolean> {
    const cfg = await Config.current()
    return cfg.oryn?.enabled === true
  }
}
