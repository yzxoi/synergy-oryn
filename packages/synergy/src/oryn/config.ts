import { Config } from "../config/config"

export namespace OrynConfig {
  export async function info() {
    const cfg = await Config.current()
    return cfg.oryn
  }

  export async function enabled(): Promise<boolean> {
    const cfg = await Config.current()
    return cfg.oryn?.enabled === true
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
