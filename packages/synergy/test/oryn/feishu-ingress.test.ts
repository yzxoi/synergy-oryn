import { Config } from "../../src/config/config"
import { expect, test } from "bun:test"
import { globalConfig } from "./fixture"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { SessionInbox } from "../../src/session/inbox"
import { SessionManager } from "../../src/session/manager"
import { Channel } from "../../src/channel"
import { OrynStore, sourceKey } from "../../src/oryn/store"
import { OrynService } from "../../src/oryn/service"
import { OrynCaseTool, OrynReplyTool } from "../../src/oryn/tools"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { Bus } from "../../src/bus"
import { mockFeishu } from "./fixtures/feishu"
import { tmpdir } from "../fixture/fixture"

async function answer(sessionID: string, rootID: string, text: string) {
  const assistant = MessageV2.Assistant.parse({
    id: Identifier.ascending("message"),
    sessionID,
    rootID,
    parentID: rootID,
    role: "assistant",
    mode: "oryn",
    agent: "oryn",
    path: { cwd: ScopeContext.current.directory, root: ScopeContext.current.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "fixture",
    providerID: "fixture",
    time: { created: Date.now() },
    metadata: { channelReply: true },
  })
  await Session.updateMessage(assistant)
  const tool = await OrynReplyTool.init()
  await tool.execute(
    { kind: "answer", text },
    {
      sessionID,
      messageID: assistant.id,
      agent: "oryn",
      abort: new AbortController().signal,
      metadata() {},
      async ask() {},
    },
  )
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "Internal terminal text must never be sent",
  })
  const completed = { ...assistant, finish: "stop", time: { ...assistant.time, completed: Date.now() } }
  await Session.updateMessage(completed)
  await Bus.publish(MessageV2.Event.Updated, { info: completed })
  return assistant.id
}

test("real Feishu ingress binds separate Oryn topics and persists each source before queue acceptance", async () => {
  await using tmp = await tmpdir({ git: true })
  const originalProvider = Channel.getProvider("feishu")
  const mock = mockFeishu()
  const accountId = `mock_${crypto.randomUUID()}`
  await using config = await globalConfig(
    Config.Info.parse({
      channel: {
        feishu: {
          type: "feishu",
          accounts: {
            [accountId]: {
              enabled: true,
              appId: "mock",
              appSecret: "mock",
              groupSessionScope: "group_thread",
            },
          },
        },
      },
      oryn: {
        enabled: true,
        routes: [{ feishuAccount: accountId, chats: ["qa"], repoAlias: "widget" }],
        repositories: { widget: { owner: "acme", repo: "widget", baseBranch: "dev" } },
      },
    }),
  )
  const sessions: string[] = []
  const caseIds: string[] = []
  try {
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        Channel.registerProvider(mock.provider)
        await Channel.reload()
        await Channel.init()
        const host = await mock.connected()
        for (const topic of ["first", "second"]) {
          const scopeKey = `qa:thread:${topic}`
          const session = await Session.create({
            scope: Scope.home(),
            agentOverride: "oryn",
            endpoint: SessionEndpoint.fromChannel({
              type: "feishu",
              accountId,
              chatId: "qa",
              chatType: "group",
              scopeKey: `oryn:${scopeKey}`,
              createdAt: Date.now(),
            }),
          })
          sessions.push(session.id)
          const lease = SessionManager.acquire(session.id)
          if (!lease) throw new Error("fixture could not reserve the session")
          try {
            const message = {
              chatId: "qa",
              chatType: "group" as const,
              senderId: "reporter",
              text: `Question ${topic}`,
              messageId: `message_${topic}`,
              threadId: topic,
              scopeKey,
              timestamp: Date.now(),
            }
            const accepted = await host.conversations.receive(message)
            expect(accepted.accepted).toBe(true)
            const inbox = await SessionInbox.list(session.id)
            expect(inbox).toHaveLength(1)
            expect(inbox[0].message?.metadata).toMatchObject({ channelDeliveryPolicy: "explicit" })
            expect(await OrynStore.sessionSourceBinding(session.id)).toMatchObject({
              role: "qa",
              identity: { accountId, chatId: "qa", threadId: scopeKey },
            })
            await host.conversations.receive(message)
            expect(await SessionInbox.list(session.id)).toHaveLength(1)
            const turn = await OrynStore.channelTurn(session.id, inbox[0].messageID)
            expect(turn).toMatchObject({ qaSessionId: session.id, identity: { messageId: message.messageId } })
            await SessionInbox.materializeItem(inbox[0])
            await answer(session.id, inbox[0].messageID, `Answer ${topic}`)
            expect(mock.replies.at(-1)).toMatchObject({
              accountId,
              messageId: message.messageId,
              scopeKey,
              parts: [{ type: "text", text: `Answer ${topic}` }],
            })
            const followup = { ...message, messageId: `followup_${topic}`, text: "One more question" }
            await host.conversations.receive(followup)
            const next = (await SessionInbox.list(session.id)).find((item) =>
              item.deliveryKey?.endsWith(followup.messageId),
            )!
            await SessionInbox.materializeItem(next)
            const assistantID = await answer(session.id, next.messageID, `Followup ${topic}`)
            expect(mock.replies.at(-1)).toMatchObject({
              messageId: followup.messageId,
              parts: [{ type: "text", text: `Followup ${topic}` }],
            })
            const caseTool = await OrynCaseTool.init()
            const ctx = {
              sessionID: session.id,
              messageID: assistantID,
              agent: "oryn",
              abort: new AbortController().signal,
              metadata() {},
              async ask() {},
            }
            const params = {
              input: {
                action: "submit" as const,
                requestKey: "feedback",
                kind: "bug" as const,
                summary: `Issue ${topic}`,
              },
            }
            const submitted = await caseTool.execute(params, ctx)
            const caseId = String(submitted.metadata.caseId)
            caseIds.push(caseId)
            const record = await OrynStore.getCase(caseId)
            expect(record?.sourceIds).toEqual([
              sourceKey({
                provider: "feishu",
                accountId,
                chatId: "qa",
                threadId: scopeKey,
                messageId: followup.messageId,
              }),
            ])
            expect((await caseTool.execute(params, ctx)).metadata.caseId).toBe(caseId)
            expect((await caseTool.execute({ input: { action: "get", caseId } }, ctx)).metadata.caseId).toBe(caseId)
            const listing = await caseTool.execute({ input: { action: "list" } }, ctx)
            expect(listing.output).toContain(caseId)
            if (caseIds.length > 1) {
              expect(listing.output).not.toContain(caseIds[0])
              await expect(
                caseTool.execute({ input: { action: "get", caseId: caseIds[0] } }, ctx),
              ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" })
            }
            await OrynService.reply({
              callerSessionID: session.id,
              turnID: next.messageID,
              caseId,
              kind: "accepted",
              text: `Accepted ${topic}`,
            })
            await OrynService.drainOutbox()
            expect(mock.replies.at(-1)).toMatchObject({
              messageId: followup.messageId,
              parts: [{ type: "text", text: `Accepted ${topic}` }],
            })
          } finally {
            await SessionManager.release(lease, { requestNextWork: false })
          }
        }
        expect(sessions[0]).not.toBe(sessions[1])
        expect(mock.replies).toHaveLength(6)
        expect(mock.reactions).toHaveLength(0)
        expect(mock.streamingCalls).toHaveLength(0)
        const ordinary = await Session.create({
          scope: Scope.home(),
          endpoint: SessionEndpoint.fromChannel({
            type: "feishu",
            accountId,
            chatId: "unlisted",
            chatType: "group",
            scopeKey: "unlisted:thread:topic",
            createdAt: Date.now(),
          }),
        })
        const lease = SessionManager.acquire(ordinary.id)
        if (!lease) throw new Error("fixture could not reserve ordinary session")
        try {
          await host.conversations.receive({
            chatId: "unlisted",
            chatType: "group",
            senderId: "reporter",
            text: "Ordinary message",
            messageId: "ordinary",
            scopeKey: "unlisted:thread:topic",
            timestamp: Date.now(),
          })
          expect(await SessionInbox.list(ordinary.id)).toHaveLength(1)
          expect(await OrynStore.sessionSourceBinding(ordinary.id)).toBeUndefined()
        } finally {
          await SessionManager.release(lease, { requestNextWork: false })
        }
      },
    })
  } finally {
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        await Channel.stopAll()
        for await (const session of Session.listAll()) {
          if (session.endpoint?.channel.accountId === accountId) await Session.remove(session.id)
        }
      },
    })
    OrynService.setOutboxDeliverer(undefined)
    if (originalProvider) Channel.registerProvider(originalProvider)
  }
})
