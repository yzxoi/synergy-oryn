import { expect, test } from "bun:test"
import { z } from "zod"
import { Config } from "../../src/config/config"
import { tmpdir } from "./fixture"
import { scriptedModel, type ModelRequest } from "./fixtures/model"
import { runtimeProcess } from "./fixtures/runtime-process"

function content(request: ModelRequest, role?: string) {
  return request.messages
    .filter((message) => !role || message.role === role)
    .map((message) => {
      if (typeof message.content === "string") return message.content
      return JSON.stringify(message.content)
    })
    .join("\n")
}
function required(text: string, pattern: RegExp) {
  const value = pattern.exec(text)?.[1]
  if (!value) throw new Error(`Missing fixture identity for ${pattern}`)
  return value
}

function message(key: string) {
  return {
    chatId: "qa",
    chatType: "group" as const,
    senderId: `reporter-${key}`,
    messageId: `report-${key}`,
    scopeKey: `qa:thread:${key}`,
    threadId: key,
    text: `Investigate ${key} feedback`,
    timestamp: 1_780_000_000_000,
  }
}

for (const interruption of ["model", "issue"] as const)
  test.skipIf(process.platform === "win32")(
    `two Feishu Cases recover after runtime death during ${interruption} without duplicate issues or crossed replies`,
    async () => {
      await using repo = await tmpdir({ git: true })
      await using storage = await tmpdir()
      await Bun.$`git remote add origin https://github.com/acme/oryn-fixture.git`.cwd(repo.path).quiet()
      await Bun.$`git update-ref refs/remotes/origin/dev HEAD`.cwd(repo.path).quiet()
      const replies: Record<string, unknown>[] = []
      const writes: Record<string, unknown>[] = []
      const issues = new Map<
        string,
        { number: number; title: string; state: string; markerPresent: boolean; authorIsApp: boolean }
      >()
      const brokerErrors: string[] = []
      const release = Promise.withResolvers<void>()
      let restarted = false
      const broker = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          try {
            const envelope = z
              .object({ operation: z.string(), input: z.record(z.string(), z.unknown()) })
              .parse(await request.json())
            if (envelope.operation === "feishu.reply") {
              replies.push(envelope.input)
              return Response.json({ messageId: `remote-reply-${replies.length}` })
            }
            const input = z
              .object({
                repository: z.literal("acme/oryn-fixture"),
                marker: z.string(),
                operation: z.string().optional(),
                title: z.string().optional(),
                issueNumber: z.number().optional(),
              })
              .parse(envelope.input)
            if (envelope.operation === "github.observe") {
              const issue = issues.get(input.marker)
              return Response.json({
                ...(issue && (!input.issueNumber || input.issueNumber === issue.number) ? { issue } : {}),
                ci: { state: "none" },
              })
            }
            if (envelope.operation !== "github.execute" || input.operation !== "ensure_issue")
              throw new Error("Unexpected external write")
            if (issues.has(input.marker)) throw new Error("Duplicate issue creation after restart")
            const issue = {
              number: 101 + issues.size,
              title: input.title!,
              state: "open",
              markerPresent: true,
              authorIsApp: true,
            }
            issues.set(input.marker, issue)
            writes.push(envelope.input)
            if (interruption === "issue" && !restarted) await release.promise
            return Response.json({
              refs: { issueNumber: issue.number, url: `https://github.com/acme/oryn-fixture/issues/${issue.number}` },
            })
          } catch (error) {
            brokerErrors.push(String(error))
            return Response.json({ error: String(error) }, { status: 400 })
          }
        },
      })
      const blocked = new Set<string>()
      await using model = scriptedModel(async (request) => {
        const has = (tool: string) => request.tools?.some((item) => item.function.name === tool)
        const text = content(request)
        const results = content(request, "tool")
        if (has("oryn_reply") && !has("oryn_dispatch")) {
          if (text.includes("Capacity question"))
            return results.includes("entryId:")
              ? { text: "Capacity answer delivered" }
              : { tool: "oryn_reply", input: { kind: "answer", text: "QA can answer while engineering is busy." } }
          const key = required(text, /Investigate (alpha|beta) feedback/)
          if (!results.includes("caseId:"))
            return {
              tool: "oryn_case",
              input: {
                input: {
                  action: "submit",
                  requestKey: key,
                  kind: "bug",
                  summary: `Investigate ${key} feedback`,
                  observed: `${key} platform behavior differs`,
                  expected: `${key} behavior matches the report`,
                },
              },
            }
          const caseId = required(results, /caseId: ([^\s\\]+)/)
          if (!results.includes("entryId:"))
            return { tool: "oryn_reply", input: { kind: "accepted", caseId, text: `${key} 已记录，正在调查。` } }
          return { text: "Internal QA completion" }
        }
        if (has("oryn_dispatch")) {
          const caseId = required(text, /Investigate Oryn case ([^\s.]+)/)
          const key = required(text, /Investigate (alpha|beta) feedback/)
          if (results.includes("control: human_owned")) return { text: "Internal handoff completion" }
          if (/"outcome":\s*"needs_human"/.test(results))
            return {
              tool: "oryn_case",
              input: {
                input: {
                  action: "request_handoff",
                  caseId,
                  reason: `${key}: reporter platform unavailable; a human must validate the reproduction.`,
                },
              },
            }
          if (!/"issueNumber":\s*\d+/.test(results))
            return {
              tool: "oryn_publish",
              input: {
                caseId,
                operation: "ensure_issue",
                requestKey: "tracking",
                title: `Investigate ${key} feedback`,
              },
            }
          const reportId = /Oryn repro result ([^\s]+) for assignment/.exec(text)?.[1]
          if (reportId) return { tool: "oryn_result", input: { input: { kind: "get", caseId, reportId } } }
          if (!results.includes("assignmentId:"))
            return {
              tool: "oryn_dispatch",
              input: { input: { action: "dispatch", caseId, stage: "repro", requestKey: "repro" } },
            }
          return { text: "Waiting for the reproduction report" }
        }
        if (has("oryn_check")) {
          const worker = {
            caseId: required(text, /Case: ([^\s]+)/),
            attemptId: required(text, /Attempt: ([^\s]+)/),
            assignmentId: required(text, /Oryn assignment ([^\s]+)/),
          }
          if (interruption === "model" && !restarted) {
            blocked.add(worker.assignmentId)
            await release.promise
            return { text: "Interrupted request ended" }
          }
          if (results.includes("reportId:")) return { text: "Structured result submitted" }
          return {
            tool: "oryn_result",
            input: {
              input: {
                ...worker,
                kind: "repro",
                requestKey: "platform-result",
                outcome: "needs_human",
                summary: "Reporter platform is unavailable in this runtime",
                limitations: ["Requires the reporter platform"],
              },
            },
          }
        }
        return { text: "Fixture summary" }
      }, 128)
      const boot = `${storage.path}/boot.json`
      await Bun.write(
        boot,
        JSON.stringify({
          broker: `http://127.0.0.1:${broker.port}`,
          config: Config.Info.parse({
            model: "oryn-fixture/qa",
            mid_model: "oryn-fixture/qa",
            thinking_model: "oryn-fixture/qa",
            mini_model: "oryn-fixture/qa",
            nano_model: "oryn-fixture/qa",
            enabled_providers: ["oryn-fixture"],
            provider: { "oryn-fixture": model.config },
            embedding: { apiKey: "fixture-only", model: "fixture-embedding", baseURL: model.config.api },
            execution: { agentWorkers: 3, agentWorkerMinIdle: 0, toolConcurrency: 4, policyWorkers: 1 },
            channel: {
              feishu: {
                type: "feishu",
                accounts: {
                  fixture: { enabled: true, appId: "mock", appSecret: "mock", groupSessionScope: "group_thread" },
                },
              },
            },
            oryn: {
              enabled: true,
              routes: [{ feishuAccount: "fixture", chats: ["qa"], repoAlias: "fixture" }],
              repositories: {
                fixture: { owner: "acme", repo: "oryn-fixture", baseBranch: "dev", directory: repo.path },
              },
            },
          }),
        }),
      )
      try {
        await using first = await runtimeProcess({ home: `${storage.path}/home`, boot })
        expect((await fetch(`http://127.0.0.1:${first.port}/global/health`)).ok).toBe(true)
        await Promise.all([first.receive(message("alpha")), first.receive(message("beta"))])
        const reached = () => (interruption === "model" ? blocked.size : writes.length)
        const deadline = Date.now() + 60000
        while (
          (reached() < 2 || replies.length < 2) &&
          !model.errors.length &&
          !brokerErrors.length &&
          Date.now() < deadline
        )
          await Bun.sleep(50)
        expect({
          blocked: reached(),
          errors: model.errors,
          brokerErrors,
          logs: reached() === 2 ? "" : first.output().slice(-3000),
        }).toEqual({ blocked: 2, errors: [], brokerErrors: [], logs: "" })
        const replyCount = interruption === "model" ? 5 : 4
        if (interruption === "model") {
          await first.receive({ ...message("capacity"), text: "Capacity question" })
          const deadline = Date.now() + 30000
          while (
            !replies.some((reply) => JSON.stringify(reply).includes("QA can answer while engineering is busy.")) &&
            !model.errors.length &&
            Date.now() < deadline
          )
            await Bun.sleep(50)
          expect({ replies, errors: model.errors }).toMatchObject({
            replies: expect.arrayContaining([
              expect.objectContaining({
                messageId: "report-capacity",
                parts: [{ type: "text", text: "QA can answer while engineering is busy." }],
              }),
            ]),
            errors: [],
          })
          expect(blocked.size).toBe(2)
          expect(restarted).toBe(false)
        }
        const before = await first.snapshot()
        expect(before.cases).toHaveLength(2)
        expect(before.assignments).toHaveLength(interruption === "model" ? 2 : 0)
        if (interruption === "model") {
          expect(before.agents.active).toBeGreaterThanOrEqual(2)
          expect(before.agents.workers).toBeGreaterThanOrEqual(2)
          expect(new Set(before.assignments.map((item) => item.sessionId)).size).toBe(2)
          expect(new Set(before.assignments.map((item) => item.workspaceRef)).size).toBe(2)
        } else {
          expect(before.actions.map((action) => action.state)).toEqual(["in_flight", "in_flight"])
          expect(before.cases.every((record) => record.issueNumber === undefined)).toBe(true)
        }
        expect(writes).toHaveLength(2)
        expect(before.reactions).toBe(0)
        expect(before.streaming).toBe(0)
        await first.crash()
        restarted = true
        release.resolve()
        await using second = await runtimeProcess({ home: `${storage.path}/home`, boot })
        expect(second.pid).not.toBe(first.pid)
        let after = await second.snapshot()
        const finish = Date.now() + 60000
        while (
          (!after.cases.every((record) => record.control === "human_owned") ||
            after.sessions.some((session) => !session.exists || session.running) ||
            replies.length < replyCount) &&
          !model.errors.length &&
          !brokerErrors.length &&
          Date.now() < finish
        ) {
          await Bun.sleep(100)
          after = await second.snapshot()
        }
        expect(model.errors).toEqual([])
        expect(brokerErrors).toEqual([])
        expect(after.cases.map((record) => record.control)).toEqual(["human_owned", "human_owned"])
        if (interruption === "model")
          expect(after.assignments.map((item) => item.id).sort()).toEqual(
            before.assignments.map((item) => item.id).sort(),
          )
        for (const session of before.sessions)
          expect(after.sessions.find((item) => item.id === session.id)?.roots).toEqual(session.roots)
        expect(after.sessions.every((session) => session.exists && session.roots.length > 0)).toBe(true)
        expect(after.assignments).toHaveLength(2)
        expect(after.actions.map((action) => action.state)).toEqual(["acknowledged", "acknowledged"])
        expect(after.cases.map((record) => record.issueNumber).sort()).toEqual([101, 102])
        expect(after.assignments.every((item) => !!item.acceptedReportId)).toBe(true)
        expect(replies).toHaveLength(replyCount)
        for (const key of ["alpha", "beta"]) {
          const matched = replies.filter((reply) => JSON.stringify(reply).includes(`report-${key}`))
          expect(matched).toHaveLength(2)
          expect(matched.some((reply) => JSON.stringify(reply).includes(`${key}: reporter platform unavailable`))).toBe(
            true,
          )
        }
        await Promise.all([second.receive(message("alpha")), second.receive(message("beta"))])
        expect((await second.snapshot()).cases).toHaveLength(2)
        expect(writes).toHaveLength(2)
        expect(replies).toHaveLength(replyCount)
        expect(after.reactions).toBe(0)
        expect(after.streaming).toBe(0)
      } finally {
        release.resolve()
        await broker.stop(true)
      }
    },
    180000,
  )
