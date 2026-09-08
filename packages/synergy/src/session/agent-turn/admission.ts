import type { RolloutSchema } from "../rollout/schema"

export namespace AgentTurnAdmission {
  const providers = new Map<string, (owner: RolloutSchema.Owner) => Promise<boolean>>()

  export function register(id: string, provider: (owner: RolloutSchema.Owner) => Promise<boolean>) {
    providers.set(id, provider)
    return () => {
      if (providers.get(id) === provider) providers.delete(id)
    }
  }

  export async function background(owner: RolloutSchema.Owner): Promise<boolean> {
    for (const provider of providers.values()) if (await provider(owner)) return true
    return false
  }
}
