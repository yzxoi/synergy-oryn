import type { ChannelHost } from "../../../src/channel/host"
import type { ConversationCapabilities, Provider } from "../../../src/channel/types"

export function mockFeishu() {
  let host: ChannelHost.Instance | undefined
  const replies: Parameters<NonNullable<ConversationCapabilities["replyMessage"]>>[0][] = []
  const reactions: string[] = []
  const streamingCalls: string[] = []
  const provider: Provider = {
    type: "feishu",
    lifecycle: "self_connected",
    async connect(input) {
      host = input.host
    },
    async disconnect() {
      host = undefined
    },
    conversation: {
      async replyMessage(input) {
        replies.push(structuredClone(input))
        return { messageId: `mock_reply_${replies.length}` }
      },
      async addReaction(input) {
        reactions.push(input.emoji)
      },
      createStreamingSession() {
        streamingCalls.push("create")
        return {
          async start() {
            streamingCalls.push("start")
          },
          async update() {
            streamingCalls.push("update")
          },
          async updateToolProgress() {
            streamingCalls.push("tool")
          },
          async close() {
            streamingCalls.push("close")
          },
          isActive: () => false,
        }
      },
    },
  }
  return {
    provider,
    replies,
    reactions,
    streamingCalls,
    async connected() {
      const deadline = Date.now() + 2000
      while (!host && Date.now() < deadline) await Bun.sleep(5)
      if (!host) throw new Error("mock Feishu did not connect")
      return host
    },
  }
}
