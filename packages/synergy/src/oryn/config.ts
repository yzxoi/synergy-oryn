import { Config } from "../config/config"

export namespace OrynConfig {
  export async function info() {
    const cfg = await Config.globalRaw()
    return cfg.oryn
  }

  export async function enabled(): Promise<boolean> {
    return (await info())?.enabled === true
  }

  export function profiles(config: Config.Info["oryn"], repoAlias: string) {
    const repository = config?.repositories?.[repoAlias]
    if (!config?.enabled || !repository) return {}
    return Object.fromEntries(
      Object.entries(config.executionProfiles ?? {})
        .filter(([id]) => !repository.testProfiles || repository.testProfiles.includes(id))
        .map(([id, configured]) => {
          const profile =
            config.executionMode === "trusted_local"
              ? { ...configured, isolation: "trusted_local" as const }
              : configured
          const ceiling = config.limits?.processResources
          if (!ceiling) return [id, profile]
          const limits = profile.resourceLimits ?? ceiling
          return [
            id,
            {
              ...profile,
              resourceLimits: {
                maxSeconds: Math.min(limits.maxSeconds ?? 1800, ceiling.maxSeconds ?? 1800),
                memoryMiB: Math.min(limits.memoryMiB, ceiling.memoryMiB),
                cpuQuotaPercent: Math.min(limits.cpuQuotaPercent, ceiling.cpuQuotaPercent),
                maxProcesses: Math.min(limits.maxProcesses, ceiling.maxProcesses),
              },
            },
          ]
        }),
    )
  }

  /**
   * Resolve the repoAlias for an inbound source. Explicit routes only: the
   * first route whose account matches and whose optional chat allowlist
   * contains the chat wins. Unknown targets must be clarified with the
   * reporter — never a default repository.
   */
  export function resolveRepoAlias(
    oryn: { routes?: Array<{ feishuAccount: string; chats?: string[]; repoAlias: string }> } | undefined,
    input: { accountId: string; chatId?: string },
  ): string | undefined {
    for (const route of oryn?.routes ?? []) {
      if (route.feishuAccount !== input.accountId) continue
      if (route.chats?.length && (!input.chatId || !route.chats.includes(input.chatId))) continue
      return route.repoAlias
    }
    return undefined
  }
}
