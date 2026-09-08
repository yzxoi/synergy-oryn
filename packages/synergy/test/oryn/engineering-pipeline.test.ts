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
import { globalConfig, tmpdir } from "./fixture"
import { mockFeishu } from "./fixtures/feishu"
import { scriptedModel, type ModelRequest } from "./fixtures/model"

function content(request: ModelRequest, role?: string) {
  return request.messages
    .filter((message) => !role || message.role === role)
    .map((message) => {
      if (typeof message.content === "string") return message.content
      if (Array.isArray(message.content))
        return message.content
          .map((part) => (typeof part === "object" && part !== null && "text" in part ? part.text : ""))
          .join("\n")
      return ""
    })
    .join("\n")
}

function required(text: string, pattern: RegExp, field: string) {
  const value = pattern.exec(text)?.[1]
  if (!value) throw new Error(`scripted scenario has no ${field}: ${text.slice(-800)}`)
  return value
}

const handoffReason =
  "The supplied attachment scenario passes on the baseline; the reporter must provide the failing input and client version."

test(
  "Feishu feedback starts a real Boss reproduction and returns an unreproduced result to its source",
  async () => {
    await using repo = await tmpdir({ git: true })
    await Bun.write(
      `${repo.path}/forward.ts`,
      "export const forward = (message: { attachments: string[] }) => [...message.attachments]\n",
    )
    await Bun.write(
      `${repo.path}/check.ts`,
      'import { strict as assert } from "node:assert"\nimport { forward } from "./forward"\nassert.deepEqual(forward({ attachments: ["report.png"] }), ["report.png"])\nconsole.log("attachment assertion passed")\n',
    )
    await Bun.$`git add forward.ts check.ts`.cwd(repo.path).quiet()
    await Bun.$`git commit -m "test: add attachment scenario"`.cwd(repo.path).quiet()
    await Bun.$`git remote add origin https://github.com/acme/oryn-fixture.git`.cwd(repo.path).quiet()
    await Bun.$`git update-ref refs/remotes/origin/dev HEAD`.cwd(repo.path).quiet()
    const baseline = (await Bun.$`git rev-parse HEAD`.cwd(repo.path).text()).trim()
    const accountId = `engineering_${crypto.randomUUID()}`
    const mock = mockFeishu()
    const originalProvider = Channel.getProvider("feishu")
    await using model = scriptedModel(async (request) => {
      const has = (name: string) => request.tools?.some((tool) => tool.function.name === name)
      const text = content(request)
      const results = content(request, "tool")
      if (has("oryn_reply")) {
        if (!results.includes("caseId:"))
          return {
            tool: "oryn_case",
            input: {
              input: {
                action: "submit",
                requestKey: "attachment",
                kind: "bug",
                summary: "Attachment does not reach the answer",
                observed: "Reporter says the image is absent",
                expected: "Forwarding preserves the attachment",
              },
            },
          }
        const caseId = required(results, /caseId: ([^\s\\]+)/, "QA Case")
        if (!results.includes("entryId:"))
          return { tool: "oryn_reply", input: { kind: "accepted", caseId, text: "已记录，后台开始调查。" } }
        return { text: "Internal QA completion" }
      }
      if (has("oryn_dispatch")) {
        const caseId = required(text, /Investigate Oryn case ([^\s.]+)/, "engineering Case")
        if (results.includes("control: human_owned")) return { text: "Internal engineering completion" }
        if (results.includes('"outcome": "inconclusive"'))
          return { tool: "oryn_case", input: { input: { action: "request_handoff", caseId, reason: handoffReason } } }
        const reportId = /Oryn repro result ([^\s]+) for assignment/.exec(text)?.[1]
        if (reportId) return { tool: "oryn_result", input: { input: { kind: "get", caseId, reportId } } }
        if (!results.includes("assignmentId:"))
          return {
            tool: "oryn_dispatch",
            input: { input: { action: "dispatch", caseId, stage: "repro", requestKey: "reproduce-attachment" } },
          }
        return { text: "Waiting for the reproduction report" }
      }
      if (has("oryn_check")) {
        const worker = {
          caseId: required(text, /Case: ([^\s]+)/, "worker Case"),
          attemptId: required(text, /Attempt: ([^\s]+)/, "worker Attempt"),
          assignmentId: required(text, /Oryn assignment ([^\s]+)/, "worker Assignment"),
        }
        if (results.includes("reportId:")) return { text: "Internal reproduction completion" }
        const runId = /runId: ([^\s\\]+)/.exec(results)?.[1]
        if (runId) {
          if (!results.includes("outcome: passed"))
            throw new Error(`fixture check did not pass: ${results.slice(-1200)}`)
          const rootID = (await OrynStore.getCase(worker.caseId))?.engineeringSessionId
          if (!rootID) throw new Error("fixture has no engineering root")
          const idleDeadline = Date.now() + 10000
          while (SessionManager.isRunning(rootID) && Date.now() < idleDeadline) await Bun.sleep(10)
          if (SessionManager.isRunning(rootID)) throw new Error("fixture engineering root did not yield before report")
          return {
            tool: "oryn_result",
            input: {
              input: {
                kind: "repro",
                ...worker,
                requestKey: "repro-observation",
                outcome: "inconclusive",
                summary: handoffReason,
                runIds: [runId],
                limitations: ["The provided input does not reproduce the reporter's observation"],
              },
            },
          }
        }
        const planId = /planId: ([^\s\\]+)/.exec(results)?.[1]
        if (planId)
          return { tool: "oryn_check", input: { input: { action: "run", ...worker, planId, lane: "baseline" } } }
        return {
          tool: "oryn_check",
          input: {
            input: {
              action: "propose",
              ...worker,
              scenario: "Forward a message with one attachment",
              profileId: "fixture",
              argv: [["bun", "check.ts"]],
              checks: ["forward preserves report.png in its returned attachment list"],
            },
          },
        }
      }
      return { text: "Attachment investigation" }
    }, 96)
    await using config = await globalConfig(
      Config.Info.parse({
        model: "oryn-fixture/qa",
        mid_model: "oryn-fixture/qa",
        thinking_model: "oryn-fixture/qa",
        mini_model: "oryn-fixture/qa",
        nano_model: "oryn-fixture/qa",
        enabled_providers: ["oryn-fixture"],
        provider: { "oryn-fixture": model.config },
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
          repositories: { fixture: { owner: "acme", repo: "oryn-fixture", baseBranch: "dev", directory: repo.path } },
          executionProfiles: { fixture: { commandAllowlist: ["bun"], timeoutSeconds: 10 } },
        },
      }),
    )
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const owned = new Set<string>()
        const cases = () => OrynStore.listCases({ repoAlias: "fixture" })
        try {
          Channel.registerProvider(mock.provider)
          await Channel.reload()
          await Channel.init()
          const host = await mock.connected()
          expect(
            (
              await host.conversations.receive({
                chatId: "qa",
                chatType: "group",
                senderId: "reporter",
                messageId: "report",
                scopeKey: "qa:thread:attachment",
                threadId: "attachment",
                text: "附件没有进入回答，请复现。",
                timestamp: Date.now(),
              })
            ).accepted,
          ).toBe(true)
          let record: Awaited<ReturnType<typeof OrynStore.getCase>>
          const deadline = Date.now() + 45000
          while (!model.errors.length && Date.now() < deadline) {
            for await (const session of Session.listAll()) {
              if (session.endpoint?.channel.accountId !== accountId) continue
              owned.add(session.id)
              record = (await OrynStore.listCasesForSession(session.id))[0]
            }
            if (record?.engineeringSessionId) owned.add(record.engineeringSessionId)
            if (record)
              for (const assignment of await OrynStore.listAssignments(record.id))
                if (assignment.sessionId) owned.add(assignment.sessionId)
            if (record?.control === "human_owned") break
            await Bun.sleep(50)
          }
          if (model.errors.length)
            throw new Error(
              JSON.stringify({
                errors: model.errors,
                requests: model.requests.map((r) => ({
                  tools: r.tools?.map((t) => t.function.name),
                  tail: content(r).slice(-2200),
                })),
              }).slice(-14000),
            )
          if (record?.control !== "human_owned") {
            const diagnostics = []
            for (const id of owned)
              diagnostics.push({
                agent: (await Session.get(id)).agentOverride,
                running: SessionManager.isRunning(id),
                inbox: await SessionInbox.list(id),
                messages: (await Session.messages({ sessionID: id })).map((m) => ({
                  role: m.info.role,
                  root: m.info.rootID,
                  parts: m.parts.flatMap((p) =>
                    p.type === "text"
                      ? [p.text.slice(-1000)]
                      : p.type === "tool"
                        ? [JSON.stringify({ tool: p.tool, state: p.state })]
                        : [],
                  ),
                })),
              })
            throw new Error(JSON.stringify({ record, steps: model.steps, diagnostics }).slice(0, 30000))
          }
          const assignments = await OrynStore.listAssignments(record.id)
          expect(assignments).toHaveLength(1)
          expect(assignments[0].stage).toBe("repro")
          expect(assignments[0].acceptedReportId).toBeDefined()
          const runs = await OrynStore.listRuns(record.id)
          expect(runs).toHaveLength(1)
          expect(runs[0]).toMatchObject({
            actualSha: baseline,
            lane: "baseline",
            outcome: "passed",
            assignmentId: assignments[0].id,
          })
          expect(JSON.stringify(runs[0].observations)).toContain("attachment assertion passed")
          const deliveryDeadline = Date.now() + 3000
          while (mock.replies.length < 2 && Date.now() < deliveryDeadline) await Bun.sleep(20)
          expect(mock.replies).toHaveLength(2)
          expect(mock.replies[1]).toMatchObject({ accountId, messageId: "report" })
          expect(JSON.stringify(mock.replies[1].parts)).toContain(handoffReason)
          expect(mock.reactions).toEqual([])
          expect(mock.streamingCalls).toEqual([])
        } finally {
          await Channel.stopAll()
          for await (const session of Session.listAll())
            if (session.endpoint?.channel.accountId === accountId) owned.add(session.id)
          for (const record of await cases()) {
            const sources = await Promise.all(record.sourceIds.map((key) => OrynStore.getSource(key)))
            if (!sources.some((source) => source?.identity.accountId === accountId)) continue
            if (record.engineeringSessionId) owned.add(record.engineeringSessionId)
            for (const assignment of await OrynStore.listAssignments(record.id))
              if (assignment.sessionId) owned.add(assignment.sessionId)
          }
          for (const id of owned) SessionInvoke.cancel(id, { recoverQueuedTasks: false })
          const deadline = Date.now() + 5000
          while ([...owned].some((id) => SessionManager.isRunning(id)) && Date.now() < deadline) await Bun.sleep(10)
          if ([...owned].some((id) => SessionManager.isRunning(id)))
            throw new Error("fixture engineering tasks did not stop")
          for (const id of [...owned].reverse()) await Session.remove(id)
          if (originalProvider) Channel.registerProvider(originalProvider)
        }
      },
    })
  },
  { timeout: 65000 },
)
