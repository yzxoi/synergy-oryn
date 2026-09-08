import { z } from "zod"
import { OrynConfig } from "../oryn/config"
import { OrynStore, storeError } from "../oryn/store"
import { OrynService } from "../oryn/service"
import { getProvider } from "./provider-registry"
import { Lock } from "../util/lock"
import type { MessageContext } from "./types"

export namespace ChannelOryn {
  export async function route(message: MessageContext, accountConfig: unknown) {
    if (message.channelType !== "feishu") return undefined
    const config = await OrynConfig.info()
    if (!config?.enabled) return undefined
    const repoAlias = OrynConfig.resolveRepoAlias(config, message)
    if (!repoAlias) return undefined
    if (!config.repositories?.[repoAlias]) throw storeError("NOT_AUTHORIZED", "Oryn repository route is unavailable")
    const account = z.object({ groupSessionScope: z.string().optional() }).parse(accountConfig)
    if (message.chatType === "group" && (account.groupSessionScope !== "group_thread" || !message.scopeKey)) {
      throw storeError("NOT_AUTHORIZED", "Oryn group accounts require group_thread conversation scope")
    }
    return { scopeKey: `oryn:${message.scopeKey ?? message.chatId}`, agent: "oryn" }
  }

  export async function bindSource(sessionID: string, message: MessageContext) {
    using _lock = await Lock.write(`oryn-channel-bind:${sessionID}`)
    const identity = {
      provider: "feishu" as const,
      accountId: message.accountId,
      chatId: message.chatId,
      threadId: message.scopeKey ?? message.chatId,
      messageId: message.messageId,
    }
    const current = await OrynStore.sessionSourceBinding(sessionID)
    if (current) {
      if (
        current.role !== "qa" ||
        current.identity?.accountId !== identity.accountId ||
        current.identity.chatId !== identity.chatId ||
        current.identity.threadId !== identity.threadId
      ) {
        throw storeError("NOT_AUTHORIZED", "Oryn conversation source does not match its session")
      }
      return
    }
    await OrynStore.recordSource({ identity })
    await OrynStore.bindSessionSource({ sessionID, identity, role: "qa" })
  }

  export async function usesExplicitDelivery(sessionID: string) {
    return (await OrynStore.sessionSourceBinding(sessionID))?.role === "qa"
  }

  export async function prepareTurn(sessionID: string, rootID: string, message: MessageContext) {
    await OrynStore.recordChannelTurn({
      sessionID,
      rootID,
      chatType: message.chatType,
      scopeKey: message.scopeKey,
      identity: {
        provider: "feishu",
        accountId: message.accountId,
        chatId: message.chatId,
        threadId: message.scopeKey ?? message.chatId,
        messageId: message.messageId,
      },
    })
  }

  export function initialize(isConnected: (accountId: string) => Promise<boolean>) {
    OrynService.setOutboxDeliverer(
      async (input) => {
        const target = await OrynStore.channelSource(input.sourceKey)
        const provider = getProvider("feishu")
        const conversation = provider?.conversation ?? provider
        if (!target || !conversation?.replyMessage || !input.identity.messageId) {
          throw storeError("ENVIRONMENT_UNAVAILABLE", "Feishu reply target is unavailable")
        }
        await conversation.replyMessage({
          accountId: input.identity.accountId,
          messageId: input.identity.messageId,
          chatId: input.identity.chatId,
          chatType: target.chatType,
          scopeKey: target.scopeKey,
          parts: [{ type: "text", text: input.text }],
        })
      },
      async (input) => {
        if (input.identity.provider !== "feishu" || !input.identity.messageId) return false
        if (!(await isConnected(input.identity.accountId))) return false
        const config = await OrynConfig.info()
        if (!config?.enabled || !OrynConfig.resolveRepoAlias(config, input.identity)) return false
        const source = await OrynStore.channelSource(input.sourceKey)
        return source !== undefined
      },
    )
  }

  export const drain = () => OrynService.drainOutbox()
}
