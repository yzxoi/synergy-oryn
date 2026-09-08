import "../../src/product-registration"
import { expect, test } from "bun:test"
import { Config } from "../../src/config/config"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInvoke } from "../../src/session/invoke"
import { SessionInbox } from "../../src/session/inbox"
import { SessionManager } from "../../src/session/manager"
import { Channel } from "../../src/channel"
import { OrynStore } from "../../src/oryn/store"
import { globalConfig } from "./fixture"
import { mockFeishu } from "./fixtures/feishu"
import { scriptedModel } from "./fixtures/model"

test(
  "scripted model enters real Feishu QA tools and hands unavailable engineering to a human",
  async () => {
    const accountId = `pipeline_${crypto.randomUUID()}`
    const mock = mockFeishu()
    const originalProvider = Channel.getProvider("feishu")
    await using model = scriptedModel((request) => {
      if (!request.tools?.some((tool) => tool.function.name === "oryn_case")) return { text: "Fixture feedback" }
      const results = request.messages.filter((message) => message.role === "tool")
      if (!results.length)
        return {
          tool: "oryn_case",
          input: {
            input: {
              action: "submit",
              requestKey: "unavailable",
              kind: "bug",
              summary: "Attachment fails to arrive",
              expected: "Attachment arrives",
            },
          },
        }
      const text = results
        .map((result) => (typeof result.content === "string" ? result.content : JSON.stringify(result.content)))
        .join("\n")
      const caseId = /caseId: ([^\s\\]+)/.exec(text)?.[1]
      if (!caseId) throw new Error(`Case tool returned no Case identity: ${text.slice(0, 500)}`)
      if (!text.includes("engineering: blocked") || !text.includes("reason: repository_directory_required")) {
        throw new Error("fixture expected the actual missing-repository startup result")
      }
      if (!text.includes("control: human_owned"))
        return {
          tool: "oryn_case",
          input: {
            input: {
              action: "request_handoff",
              caseId,
              reason: "Test repository is not configured; a human must provide the approved environment",
            },
          },
        }
      if (!text.includes("entryId:"))
        return {
          tool: "oryn_reply",
          input: {
            kind: "needs_human",
            caseId,
            text: "已记录反馈。缺少获准的测试仓库，需要人工补充环境；尚未确认修复。",
          },
        }
      return { text: "Internal task complete" }
    })
    await using config = await globalConfig(
      Config.Info.parse({
        model: "oryn-fixture/qa",
        mid_model: "oryn-fixture/qa",
        thinking_model: "oryn-fixture/qa",
        mini_model: "oryn-fixture/qa",
        nano_model: "oryn-fixture/qa",
        enabled_providers: ["oryn-fixture"],
        provider: { "oryn-fixture": model.config },
        embedding: { apiKey: "fixture-only", model: "fixture-embedding", baseURL: model.config.api },
        channel: {
          feishu: {
            type: "feishu",
            accounts: {
              [accountId]: { enabled: true, appId: "mock", appSecret: "mock", groupSessionScope: "group_thread" },
            },
          },
        },
        oryn: {
          enabled: true,
          routes: [{ feishuAccount: accountId, chats: ["qa"], repoAlias: "fixture" }],
          repositories: { fixture: { owner: "acme", repo: "fixture", baseBranch: "dev" } },
        },
      }),
    )
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        try {
          Channel.registerProvider(mock.provider)
          await Channel.reload()
          await Channel.init()
          const host = await mock.connected()
          const event = {
            chatId: "qa",
            chatType: "group" as const,
            senderId: "reporter",
            messageId: "report",
            scopeKey: "qa:thread:case",
            threadId: "case",
            text: "附件没有进入回答，请调查。",
            timestamp: Date.now(),
          }
          expect((await host.conversations.receive(event)).accepted).toBe(true)
          const deadline = Date.now() + 30000
          while (!mock.replies.length && !model.errors.length && Date.now() < deadline) await Bun.sleep(25)
          expect(model.errors).toEqual([])
          if (!mock.replies.length) {
            const diagnostics = []
            for await (const session of Session.listAll()) {
              if (session.endpoint?.channel.accountId === accountId)
                diagnostics.push({
                  agent: session.agentOverride,
                  messages: await Session.messages({ sessionID: session.id }),
                })
            }
            throw new Error(
              JSON.stringify({
                requests: model.requests.map((r) => ({
                  tools: r.tools?.map((t) => t.function.name),
                  messages: r.messages,
                })),
                diagnostics,
              }).slice(-12000),
            )
          }
          expect(model.embeddings.length).toBeGreaterThan(0)
          expect(mock.replies).toHaveLength(1)
          expect(mock.replies[0]).toMatchObject({
            accountId,
            messageId: "report",
            parts: [
              {
                type: "text",
                text: "Oryn needs human input: Test repository is not configured; a human must provide the approved environment",
              },
            ],
          })
          const sessions = []
          for await (const session of Session.listAll())
            if (session.endpoint?.channel.accountId === accountId) sessions.push(session)
          expect(sessions).toHaveLength(1)
          const cases = await OrynStore.listCasesForSession(sessions[0].id)
          expect(cases).toHaveLength(1)
          expect(cases[0].control).toBe("human_owned")
          expect(cases[0].pullNumbers).toEqual([])
          const settled = Date.now() + 5000
          while (SessionManager.isRunning(sessions[0].id) && Date.now() < settled) await Bun.sleep(10)
          expect(SessionManager.isRunning(sessions[0].id)).toBe(false)
          const qaRequests = () =>
            model.requests.filter((request) => request.tools?.some((tool) => tool.function.name === "oryn_case")).length
          const count = qaRequests()
          await host.conversations.receive(event)
          await Bun.sleep(100)
          expect(qaRequests()).toBe(count)
          expect(await SessionInbox.list(sessions[0].id)).toHaveLength(0)
          expect(SessionManager.isRunning(sessions[0].id)).toBe(false)
          expect(mock.replies).toHaveLength(1)
          expect(mock.reactions).toEqual([])
          expect(mock.streamingCalls).toEqual([])
        } finally {
          await Channel.stopAll()
          for await (const session of Session.listAll()) {
            if (session.endpoint?.channel.accountId !== accountId) continue
            SessionInvoke.cancel(session.id, { recoverQueuedTasks: false })
            const deadline = Date.now() + 3000
            while (SessionManager.isRunning(session.id) && Date.now() < deadline) await Bun.sleep(10)
            if (SessionManager.isRunning(session.id)) throw new Error("fixture QA did not stop")
            await Session.remove(session.id)
          }
          if (originalProvider) Channel.registerProvider(originalProvider)
        }
      },
    })
  },
  { timeout: 45000 },
)
