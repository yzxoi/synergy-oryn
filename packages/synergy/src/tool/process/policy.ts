import { ProcessRegistry } from "../../process/registry"
import type { BashExecutionPolicy } from "../bash/policy"

export namespace ProcessAccessPolicy {
  export type Input = BashExecutionPolicy.Input & { action: string; processId?: string }
  export type Access = { sessionID: string }
  const providers = new Map<string, (input: Input) => Promise<Access | undefined>>()

  export function register(id: string, provider: (input: Input) => Promise<Access | undefined>) {
    providers.set(id, provider)
    return () => {
      if (providers.get(id) === provider) providers.delete(id)
    }
  }

  export async function resolve(input: Input): Promise<Access | undefined> {
    input.abort.throwIfAborted()
    let result: Access | undefined
    for (const provider of providers.values()) {
      const access = await provider(input)
      input.abort.throwIfAborted()
      if (!access) continue
      if (result) throw new Error("Multiple Host process access policies matched the Session")
      if (access.sessionID !== input.sessionID) throw new Error("Host process policy changed the owning Session")
      result = access
    }
    if (result && input.processId) {
      const target = ProcessRegistry.get(input.processId) ?? ProcessRegistry.getFinished(input.processId)
      if (target && target.sessionID !== result.sessionID) throw new Error("Process is not owned by this Session")
    }
    return result
  }
}
