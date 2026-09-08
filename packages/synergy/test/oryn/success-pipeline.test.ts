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
import { attachmentScenario } from "./fixtures/attachment-scenario"
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

test.each(["direct", "repair", "trusted_local"] as const)(
  "Feishu feedback reaches independent review and PR delivery (%s)",
  async (mode) => {
    const rework = mode === "repair"
    await using repo = await tmpdir({ git: true })
    await Bun.write(`${repo.path}/forward.ts`, "export const forward = (_message: { attachments: string[] }) => []\n")
    await Bun.write(
      `${repo.path}/check.ts`,
      'import { strict as assert } from "node:assert"\nimport { forward } from "./forward"\nconst message = { attachments: ["report.png"] }\nconst result = forward(message)\nassert.deepEqual(result, ["report.png"])\nassert.notStrictEqual(result, message.attachments)\nconsole.log("attachment assertion passed")\n',
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
    await using model = scriptedModel(
      attachmentScenario({
        baseline,
        repair: rework,
      }),
      160,
    )
    await using config = await globalConfig(
      Config.Info.parse({
        lsp: false,
        lspWriteDiagnostics: false,
        formatter: false,
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
          executionMode: mode === "trusted_local" ? "trusted_local" : "sandbox",
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
          const deadline = Date.now() + 240000
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
                messages: (await Session.messages({ sessionID: id })).slice(-3).map((m) => ({
                  role: m.info.role,
                  root: m.info.rootID,
                  parts: m.parts.flatMap((p) =>
                    p.type === "text"
                      ? [p.text.slice(-1000)]
                      : p.type === "tool"
                        ? [
                            JSON.stringify({
                              tool: p.tool,
                              status: p.state.status,
                              error: p.state.status === "error" ? p.state.error : undefined,
                            }),
                          ]
                        : [],
                  ),
                })),
              })
            throw new Error(JSON.stringify({ record, steps: model.steps.slice(-5), diagnostics }))
          }
          expect(model.embeddings.length).toBeGreaterThan(0)
          const assignments = await OrynStore.listAssignments(record.id)
          expect(assignments.map((a) => a.stage).sort()).toEqual(
            Array.from({ length: rework ? 2 : 1 }, () => ["code", "repro", "review", "verify"] as const)
              .flat()
              .sort(),
          )
          expect(new Set(assignments.map((a) => a.sessionId)).size).toBe(rework ? 8 : 4)
          expect(new Set(assignments.map((a) => a.workspaceRef)).size).toBe(rework ? 8 : 4)
          expect(assignments.every((a) => a.acceptedReportId)).toBe(true)
          const attempt = (await OrynStore.getAttempt(record.id, record.activeAttemptId))!
          if (!attempt.candidateSha) throw new Error("ready attempt has no candidate")
          expect(attempt.candidateSha).not.toBe(baseline)
          const runs = await OrynStore.listRuns(record.id)
          expect(
            runs.every((run) =>
              run.observations.some((line) =>
                line.startsWith(`execution mode: ${mode === "trusted_local" ? "trusted_local" : "sandbox"};`),
              ),
            ),
          ).toBe(true)
          expect(runs).toHaveLength(rework ? 4 : 2)
          expect(runs.find((run) => run.lane === "baseline" && run.actualSha === baseline)).toMatchObject({
            actualSha: baseline,
            outcome: "failed",
          })
          expect(runs.find((run) => run.lane === "candidate" && run.attemptId === attempt.id)).toMatchObject({
            actualSha: attempt.candidateSha,
            outcome: "passed",
            assignmentId: assignments.find((a) => a.stage === "verify" && a.attemptId === attempt.id)!.id,
          })
          expect(await Bun.file(`${repo.path}/forward.ts`).text()).toContain("=> []")
          const reviews = await OrynStore.listReviews(record.id)
          expect(reviews).toHaveLength(rework ? 2 : 1)
          expect(reviews.find((review) => review.attemptId === attempt.id)).toMatchObject({
            headSha: attempt.candidateSha,
            recommendation: "ready_for_human",
            assignmentId: assignments.find((a) => a.stage === "review" && a.attemptId === attempt.id)!.id,
          })
          expect(github.calls.map((call) => call.operation)).toEqual([
            "ensure_issue",
            "ensure_draft",
            ...(rework ? (["publish_review", "refresh_pr"] as const) : []),
            "publish_review",
            "mark_ready",
          ])
          if (rework) {
            const attempts = await OrynStore.listAttempts(record.id)
            expect(attempts).toHaveLength(2)
            expect(attempts[0].disposition).toBe("superseded")
            expect(runs.find((run) => run.attemptId === attempts[0].id && run.lane === "candidate")).toMatchObject({
              actualSha: attempts[0].candidateSha,
              outcome: "failed",
            })
            expect(reviews.find((review) => review.attemptId === attempts[0].id)?.recommendation).toBe(
              "changes_required",
            )
            expect(attempt.baselineSha).toBe(attempts[0].candidateSha!)
            expect(record.repairRounds).toBe(1)
            expect(record.pullNumbers).toEqual([55])
            expect(reviews.find((review) => review.attemptId === attempts[0].id)?.findings[0].disposition).toBe("open")
            expect(reviews.find((review) => review.attemptId === attempt.id)?.findings[0].disposition).toBe("resolved")
            const finalCode = (await OrynStore.listWorkerReports(record.id)).find(
              (report) => report.attemptId === attempt.id && report.kind === "candidate",
            )
            expect(finalCode?.addressedFindings).toEqual(["attachment-copy"])
            expect(github.calls.find((call) => call.operation === "mark_ready")?.candidateSha).toBe(
              attempt.candidateSha,
            )
          }
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
  { timeout: 270000 },
)
