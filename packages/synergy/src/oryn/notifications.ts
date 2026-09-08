import { OrynConfig } from "./config"
import { OrynStore, sourceKey } from "./store"
import type { SourceIdentity } from "./schema"

export namespace OrynNotifications {
  export async function operator(identity: SourceIdentity) {
    const config = await OrynConfig.info()
    const target = config?.notifications?.target
    return (
      !!config?.enabled &&
      !!target &&
      identity.provider === "feishu" &&
      identity.eventName === "oryn_operator" &&
      identity.accountId === target.accountId &&
      identity.chatId === target.chatId &&
      identity.threadId === target.threadId
    )
  }
  export async function attach(caseId: string) {
    const config = await OrynConfig.info()
    const target = config?.notifications?.target
    const record = await OrynStore.getCase(caseId)
    if (!config?.enabled || !target || !record) return
    const sources = await Promise.all(record.sourceIds.map((key) => OrynStore.getSource(key)))
    if (sources[0]?.identity.provider !== "github") return
    const identity: SourceIdentity = {
      provider: "feishu",
      accountId: target.accountId,
      chatId: target.chatId,
      threadId: target.threadId,
      messageId: "oryn-operator",
      eventName: "oryn_operator",
    }
    await OrynStore.recordSource({ identity })
    const key = sourceKey(identity)
    await OrynStore.linkSourceToCase(key, caseId)
    return key
  }
}
