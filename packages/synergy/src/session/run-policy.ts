import type { Info } from "./types"

export namespace SessionRunPolicy {
  const providers = new Map<string, (session: Info) => Promise<boolean | undefined>>()

  export class SuspendedError extends Error {
    constructor() {
      super("Session execution is suspended by its Host workflow")
      this.name = "SessionRunSuspendedError"
    }
  }

  export function register(id: string, provider: (session: Info) => Promise<boolean | undefined>) {
    providers.set(id, provider)
    return () => {
      if (providers.get(id) === provider) providers.delete(id)
    }
  }

  export async function allowed(session: Info): Promise<boolean> {
    for (const provider of providers.values()) if ((await provider(session)) === false) return false
    return true
  }

  export async function assert(session: Info) {
    if (!(await allowed(session))) throw new SuspendedError()
  }
}
