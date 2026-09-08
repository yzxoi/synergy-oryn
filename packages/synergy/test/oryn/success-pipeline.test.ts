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
import { setTransport } from "../../src/oryn/publish"
import { OrynGithubPublish } from "../../src/channel/provider/github/publish"
import { mockGithub } from "./fixtures/github"
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

test(
  "Feishu feedback runs reproduction, coding, independent verification and review before PR delivery",
  async () => {
    await using repo = await tmpdir({ git: true })
    await Bun.write(`${repo.path}/forward.ts`, "export const forward = (_message: { attachments: string[] }) => []\n")
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
    const github = mockGithub()
    const dispatched = new Set<string>()
    const publications = new Set<string>()
    let codeStep = 0
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
                summary: "Forwarding drops attachments",
                observed: "A message with report.png returns no attachment",
                expected: "Forwarding returns report.png",
              },
            },
          }
        if (!results.includes("entryId:"))
          return {
            tool: "oryn_reply",
            input: {
              kind: "accepted",
              caseId: required(results, /caseId: ([^\s\\]+)/, "QA Case"),
              text: "已记录，后台开始调查。",
            },
          }
        return { text: "Internal QA completion" }
      }
      if (has("oryn_dispatch")) {
        const caseId = required(text, /Investigate Oryn case ([^\s.]+)/, "engineering Case")
        const publish = (operation: "ensure_issue" | "ensure_draft" | "publish_review" | "mark_ready") => {
          publications.add(operation)
          return {
            tool: "oryn_publish",
            input: { caseId, operation, requestKey: operation, title: "fix: preserve forwarded attachments" },
          }
        }
        const dispatch = (stage: string) => {
          dispatched.add(stage)
          return { tool: "oryn_dispatch", input: { input: { action: "dispatch", caseId, stage, requestKey: stage } } }
        }
        if (!publications.has("ensure_issue")) return publish("ensure_issue")
        if (!results.includes('"issueNumber":101'))
          throw new Error(`tracking issue was not acknowledged: ${results.slice(-1800)}`)
        const reportId = [...text.matchAll(/Oryn (?:repro|code|verify|review) result ([^\s]+) for assignment/g)].at(
          -1,
        )?.[1]
        if (reportId && !results.includes(`"id": "${reportId}"`))
          return { tool: "oryn_result", input: { input: { kind: "get", caseId, reportId } } }
        if (!dispatched.has("repro")) return dispatch("repro")
        if (results.includes('"outcome": "reproduced"') && !dispatched.has("code")) return dispatch("code")
        if (results.includes('"outcome": "candidate_ready"')) {
          if (!publications.has("ensure_draft")) return publish("ensure_draft")
          if (!results.includes('"pullNumber":55'))
            throw new Error(`draft was not acknowledged: ${results.slice(-1800)}`)
          if (!dispatched.has("verify")) return dispatch("verify")
        }
        if (results.includes('"outcome": "verified"') && !dispatched.has("review")) return dispatch("review")
        if (results.includes('"recommendation": "ready_for_human"')) {
          if (!publications.has("publish_review")) return publish("publish_review")
          if (!publications.has("mark_ready")) return publish("mark_ready")
          return { text: "Internal engineering completion" }
        }
        return { text: "Waiting for the independent worker report" }
      }
      if (has("oryn_result")) {
        const worker = {
          caseId: required(text, /Case: ([^\s]+)/, "worker Case"),
          attemptId: required(text, /Attempt: ([^\s]+)/, "worker Attempt"),
          assignmentId: required(text, /Oryn assignment ([^\s]+)/, "worker Assignment"),
        }
        const stage = required(text, /\(stage: ([^)]+)\)/, "worker stage")
        if (results.includes("reportId:") || results.includes("reviewId:"))
          return { text: "Internal worker completion" }
        const report = async (input: Record<string, unknown>) => {
          const rootID = (await OrynStore.getCase(worker.caseId))?.engineeringSessionId
          if (!rootID) throw new Error("fixture has no engineering root")
          const deadline = Date.now() + 10000
          while (SessionManager.isRunning(rootID) && Date.now() < deadline) await Bun.sleep(10)
          if (SessionManager.isRunning(rootID)) throw new Error("engineering root did not yield before report")
          return { tool: "oryn_result", input: { input: { ...worker, requestKey: stage, ...input } } }
        }
        if (stage === "code") {
          const directory = required(text, /Working directory: ([^\n]+)/, "code workspace")
          if (codeStep++ === 0) return { tool: "read", input: { filePath: `${directory}/forward.ts` } }
          if (codeStep === 2) {
            if (!results.includes("=> []"))
              throw new Error(`coder did not read the buggy implementation: ${results.slice(-1200)}`)
            return {
              tool: "write",
              input: {
                filePath: `${directory}/forward.ts`,
                content: "export const forward = (message: { attachments: string[] }) => [...message.attachments]\n",
              },
            }
          }
          if (codeStep === 3)
            return {
              tool: "oryn_result",
              input: {
                input: {
                  kind: "commit_candidate",
                  ...worker,
                  requestKey: "commit",
                  title: "fix: preserve attachments",
                  paths: ["forward.ts"],
                },
              },
            }
          return report({
            kind: "candidate",
            outcome: "candidate_ready",
            summary: "Preserve the attachment list instead of returning an empty array",
            candidateSha: required(results, /candidateSha: ([0-9a-f]{40})/, "committed candidate"),
          })
        }
        if (stage === "review") {
          if (!results.includes("=> [...message.attachments]"))
            return {
              tool: "read",
              input: { filePath: `${required(text, /Working directory: ([^\n]+)/, "review workspace")}/forward.ts` },
            }
          if (!results.includes('"evidenceRunIds"'))
            return { tool: "oryn_case", input: { input: { action: "get", caseId: worker.caseId } } }
          const runIds =
            required(results, /"evidenceRunIds":\s*\[([^\]]+)\]/, "review evidence")
              .match(/"([^"]+)"/g)
              ?.map((id) => JSON.parse(id) as string) ?? []
          for (const runId of runIds)
            if (!results.includes(`"id": "${runId}"`))
              return { tool: "oryn_check", input: { input: { action: "get_run", caseId: worker.caseId, runId } } }
          if (
            !results.includes('"lane": "baseline"') ||
            !results.includes('"outcome": "failed"') ||
            !results.includes('"lane": "candidate"') ||
            !results.includes('"outcome": "passed"')
          )
            throw new Error("reviewer has no baseline and candidate execution evidence")
          return report({
            kind: "review",
            headSha: required(text, /Candidate: ([^\s]+)/, "review head"),
            baseSha: required(text, /Baseline: ([^\s]+)/, "review base"),
            findings: [],
            evidenceAssessment:
              "The baseline drops report.png; the independently executed candidate preserves it. The check runs the same assertion against both commits.",
            recommendation: "ready_for_human",
          })
        }
        const runId = /runId: ([^\s\\]+)/.exec(results)?.[1]
        if (runId) {
          const expected = stage === "repro" ? "failed" : "passed"
          if (!results.includes(`outcome: ${expected}`))
            throw new Error(`unexpected ${stage} check result: ${results.slice(-1600)}`)
          return report({
            kind: stage === "repro" ? "repro" : "verification",
            outcome: stage === "repro" ? "reproduced" : "verified",
            summary: stage === "repro" ? "The baseline drops report.png" : "The fixed candidate preserves report.png",
            runIds: [runId],
          })
        }
        const planId = /planId: ([^\s\\]+)/.exec(results)?.[1]
        if (planId)
          return {
            tool: "oryn_check",
            input: { input: { action: "run", ...worker, planId, lane: stage === "repro" ? "baseline" : "candidate" } },
          }
        return {
          tool: "oryn_check",
          input: {
            input: {
              action: "propose",
              ...worker,
              scenario: "Forward a message containing report.png",
              profileId: "fixture",
              argv: [["bun", "check.ts"]],
              checks: ["the returned attachment list contains report.png"],
            },
          },
        }
      }
      return { text: "Attachment investigation" }
    }, 160)
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
          setTransport(github.transport)
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
          const deadline = Date.now() + 90000
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
            if (
              record?.activeAttemptId &&
              (await OrynStore.getAttempt(record.id, record.activeAttemptId))?.disposition === "ready" &&
              mock.replies.length === 2 &&
              [...owned].every((id) => !SessionManager.isRunning(id))
            )
              break
            await Bun.sleep(50)
          }
          if (model.errors.length)
            throw new Error(
              JSON.stringify({
                errors: model.errors,
                requests: model.requests.map((r) => ({
                  tools: r.tools?.map((t) => t.function.name),
                  tail: content(r).slice(-600),
                })),
              }).slice(0, 18000),
            )
          if (
            !record?.activeAttemptId ||
            (await OrynStore.getAttempt(record.id, record.activeAttemptId))?.disposition !== "ready"
          ) {
            const diagnostics = []
            for (const id of owned)
              diagnostics.push({
                agent: (await Session.get(id)).agentOverride,
                running: SessionManager.isRunning(id),
                executionPhase: SessionManager.getRuntime(id)?.executionPhase,
                loopPhase: SessionManager.getRuntime(id)?.owner?.phase,
                aborted: SessionManager.getRuntime(id)?.owner?.lease.signal.aborted,
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
          expect(model.embeddings.length).toBeGreaterThan(0)
          const assignments = await OrynStore.listAssignments(record.id)
          expect(assignments.map((a) => a.stage).sort()).toEqual(["code", "repro", "review", "verify"])
          expect(new Set(assignments.map((a) => a.sessionId)).size).toBe(4)
          expect(new Set(assignments.map((a) => a.workspaceRef)).size).toBe(4)
          expect(assignments.every((a) => a.acceptedReportId)).toBe(true)
          const attempt = (await OrynStore.getAttempt(record.id, record.activeAttemptId))!
          if (!attempt.candidateSha) throw new Error("ready attempt has no candidate")
          expect(attempt.candidateSha).not.toBe(baseline)
          const runs = await OrynStore.listRuns(record.id)
          expect(runs).toHaveLength(2)
          expect(runs.find((run) => run.lane === "baseline")).toMatchObject({ actualSha: baseline, outcome: "failed" })
          expect(runs.find((run) => run.lane === "candidate")).toMatchObject({
            actualSha: attempt.candidateSha,
            outcome: "passed",
            assignmentId: assignments.find((a) => a.stage === "verify")!.id,
          })
          expect(await Bun.file(`${repo.path}/forward.ts`).text()).toContain("=> []")
          const reviews = await OrynStore.listReviews(record.id)
          expect(reviews).toHaveLength(1)
          expect(reviews[0]).toMatchObject({
            headSha: attempt.candidateSha,
            recommendation: "ready_for_human",
            assignmentId: assignments.find((a) => a.stage === "review")!.id,
          })
          expect(github.calls.map((call) => call.operation)).toEqual([
            "ensure_issue",
            "ensure_draft",
            "publish_review",
            "mark_ready",
          ])
          expect(github.pull()).toMatchObject({ headSha: attempt.candidateSha, draft: false })
          expect(github.calls.find((call) => call.operation === "mark_ready")?.body).toContain("```mermaid")
          expect(
            (await OrynStore.listActions({ caseId: record.id })).every((action) => action.state === "acknowledged"),
          ).toBe(true)
          expect(mock.replies).toHaveLength(2)
          expect(mock.replies[1]).toMatchObject({ accountId, messageId: "report" })
          expect(JSON.stringify(mock.replies[1].parts)).toContain("https://github.com/acme/oryn-fixture/pull/55")
          expect(JSON.stringify(mock.replies[1].parts)).toContain(attempt.candidateSha)
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
          setTransport(OrynGithubPublish.createTransport())
          if (originalProvider) Channel.registerProvider(originalProvider)
        }
      },
    })
  },
  { timeout: 110000 },
)
