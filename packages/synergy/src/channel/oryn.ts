import { OrynGithub } from "../oryn/github"
import { OrynNotifications } from "../oryn/notifications"
import { Storage } from "../storage/storage"
import { OrynPath } from "../oryn/path"
import { ChannelSource } from "../oryn/schema"
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

  export function initialize(isConnected: (accountId: string, channelType?: "feishu" | "github") => Promise<boolean>) {
    OrynService.setOutboxDeliverer(
      async (input) => {
        if (input.identity.provider === "github") {
          if (
            !input.identity.repo ||
            !input.identity.issueNumber ||
            !(await OrynGithub.binding(input.identity.accountId, input.identity.repo))
          )
            throw storeError("NOT_AUTHORIZED", "GitHub reply authority changed")
          const provider = getProvider("github")
          const conversation = provider?.conversation ?? provider
          if (!conversation?.pushMessage) throw storeError("ENVIRONMENT_UNAVAILABLE", "GitHub is disconnected")
          await conversation.pushMessage({
            accountId: input.identity.accountId,
            chatId: `${input.identity.repo}#${input.identity.issueNumber}`,
            parts: [{ type: "text", text: input.text }],
          })
          return
        }
        if (await OrynNotifications.operator(input.identity)) {
          const provider = getProvider("feishu")
          const conversation = provider?.conversation ?? provider
          if (!input.identity.chatId) throw storeError("NOT_AUTHORIZED", "Operator chat is unavailable")
          if (!input.identity.threadId) {
            if (!conversation?.pushMessage) throw storeError("ENVIRONMENT_UNAVAILABLE", "Feishu is disconnected")
            await conversation.pushMessage({
              accountId: input.identity.accountId,
              chatId: input.identity.chatId,
              parts: [{ type: "text", text: input.text }],
            })
            return
          }
          for (const id of await Storage.scan(["oryn", "channel_sources"])) {
            const source = ChannelSource.parse(await Storage.read(OrynPath.channelSource(id)))
            if (
              source.identity.accountId !== input.identity.accountId ||
              source.identity.chatId !== input.identity.chatId ||
              source.identity.threadId !== input.identity.threadId ||
              !source.identity.messageId
            )
              continue
            if (!conversation?.replyMessage) break
            await conversation.replyMessage({
              accountId: input.identity.accountId,
              messageId: source.identity.messageId,
              chatId: input.identity.chatId,
              chatType: source.chatType,
              scopeKey: source.scopeKey,
              parts: [{ type: "text", text: input.text }],
            })
            return
          }
          throw storeError("ENVIRONMENT_UNAVAILABLE", "Operator topic is unavailable")
        }
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
        if (input.identity.provider === "github")
          return (
            !!input.identity.repo &&
            !!(await OrynGithub.binding(input.identity.accountId, input.identity.repo)) &&
            (await isConnected(input.identity.accountId, "github"))
          )
        if (await OrynNotifications.operator(input.identity)) return isConnected(input.identity.accountId)
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
