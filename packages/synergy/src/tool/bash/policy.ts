import type { SandboxExecutionWrapper } from "../../sandbox/backend"
import type { BashSandboxPrepareInput } from "./shared"

export namespace BashExecutionPolicy {
  export type Input = { sessionID: string; agent: string; workspace: string; abort: AbortSignal }
  export type Prepared = SandboxExecutionWrapper & {
    executionMode?: "trusted_local"
    environment: Record<string, string>
    dispose: () => Promise<void>
  }
  export type Policy = { prepare: (input: BashSandboxPrepareInput) => Promise<Prepared> }
  const providers = new Map<string, (input: Input) => Promise<Policy | undefined>>()

  export function register(id: string, provider: (input: Input) => Promise<Policy | undefined>) {
    providers.set(id, provider)
    return () => {
      if (providers.get(id) === provider) providers.delete(id)
    }
  }

  export async function resolve(input: Input): Promise<Policy | undefined> {
    input.abort.throwIfAborted()
    let result: Policy | undefined
    for (const provider of providers.values()) {
      const policy = await provider(input)
      input.abort.throwIfAborted()
      if (!policy) continue
      if (result) throw new Error("Multiple Host shell execution policies matched the Session")
      result = policy
    }
    return result
  }
}
