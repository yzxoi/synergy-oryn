import { expect, test } from "bun:test"
import { z } from "zod"
import { Config } from "../../src/config/config"
import { PublishOperation } from "../../src/oryn/schema"
import { tmpdir } from "./fixture"
import { attachmentScenario } from "./fixtures/attachment-scenario"
import { mockGithub } from "./fixtures/github"
import { scriptedModel } from "./fixtures/model"
import { runtimeProcess } from "./fixtures/runtime-process"

const GitInput = z.object({
  repository: z.literal("acme/oryn-fixture"),
  operation: PublishOperation.optional(),
  candidateSha: z.string().optional(),
  branch: z.string().optional(),
  baseBranch: z.string().optional(),
  directory: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  pullNumber: z.number().optional(),
  issueNumber: z.number().optional(),
  marker: z.string().optional(),
  ref: z.string().optional(),
  deliveryCheckEnabled: z.boolean().optional(),
})

for (const interruption of ["ensure_draft", "mark_ready", "refresh_pr"] as const)
  test.skipIf(process.platform === "win32")(
    `PR pipeline resumes after runtime death following remote ${interruption}`,
    async () => {
      const repair = interruption === "refresh_pr"
      await using repo = await tmpdir({ git: true })
      await using storage = await tmpdir()
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
      const replies: Record<string, unknown>[] = []
      const github = mockGithub()
      const errors: string[] = []
      const release = Promise.withResolvers<void>()
      let held = false
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
              return Response.json({ messageId: `reply-${replies.length}` })
            }
            if (envelope.operation === "github.observe")
              return Response.json(await github.transport.observe(GitInput.parse(envelope.input)))
            if (envelope.operation !== "github.execute") throw new Error("Unexpected broker request")
            const input = GitInput.required({ operation: true }).parse(envelope.input)
            const result = await github.transport.execute(input)
            if (input.operation === interruption && !restarted) {
              held = true
              await release.promise
            }
            return Response.json(result)
          } catch (error) {
            errors.push(String(error))
            return Response.json({ error: String(error) }, { status: 400 })
          }
        },
      })
      const makeScenario = () => attachmentScenario({ baseline, repair })
      let scenario = makeScenario()
      await using model = scriptedModel((request) => scenario(request), 220)
      const boot = `${storage.path}/boot.json`
      await Bun.write(
        boot,
        JSON.stringify({
          broker: `http://127.0.0.1:${broker.port}`,
          config: Config.Info.parse({
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
            execution: { agentWorkers: 4, agentWorkerMinIdle: 0, toolConcurrency: 4, policyWorkers: 1 },
            channel: {
              feishu: {
                type: "feishu",
                accounts: {
                  fixture: {
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
              routes: [{ feishuAccount: "fixture", chats: ["qa"], repoAlias: "fixture" }],
              repositories: {
                fixture: { owner: "acme", repo: "oryn-fixture", baseBranch: "dev", directory: repo.path },
              },
              executionProfiles: { fixture: { commandAllowlist: ["bun"], timeoutSeconds: 10 } },
            },
          }),
        }),
      )
      const message = {
        chatId: "qa",
        chatType: "group" as const,
        senderId: "reporter",
        messageId: "report",
        scopeKey: "qa:thread:attachment",
        threadId: "attachment",
        text: "附件没有进入回答，请复现。",
        timestamp: 1_780_000_000_000,
      }
      try {
        await using first = await runtimeProcess({ home: `${storage.path}/home`, boot })
        expect((await first.receive(message)).accepted).toBe(true)
        const reached = Date.now() + 180000
        while ((!held || replies.length < 1) && !errors.length && !model.errors.length && Date.now() < reached)
          await Bun.sleep(50)
        const pending = held ? undefined : await first.snapshot()
        expect({
          held,
          errors,
          modelErrors: model.errors,
          logs: held
            ? ""
            : JSON.stringify({
                snapshot: pending && {
                  cases: pending.cases.map((record) => ({
                    id: record.id,
                    control: record.control,
                    activeAttemptId: record.activeAttemptId,
                  })),
                  attempts: pending.attempts.map((attempt) => ({ id: attempt.id, disposition: attempt.disposition })),
                  assignments: pending.assignments.map((assignment) => ({
                    attemptId: assignment.attemptId,
                    stage: assignment.stage,
                    accepted: !!assignment.acceptedReportId,
                  })),
                  actions: pending.actions.map((action) => ({ operation: action.operation, state: action.state })),
                  sessions: pending.sessions.map((session) => ({ id: session.id, running: session.running })),
                },
                steps: model.steps.slice(-5),
                log: first.output().slice(-1000),
              }),
        }).toEqual({ held: true, errors: [], modelErrors: [], logs: "" })
        const before = await first.snapshot()
        expect(before.cases).toHaveLength(1)
        expect(before.actions.find((action) => action.operation === interruption)?.state).toBe("in_flight")
        const candidate = github.pull()!.headSha
        expect(github.pull()).toMatchObject({ number: 55, headSha: candidate, draft: interruption !== "mark_ready" })
        await first.crash()
        restarted = true
        scenario = makeScenario()
        release.resolve()
        await using second = await runtimeProcess({ home: `${storage.path}/home`, boot })
        expect(second.pid).not.toBe(first.pid)
        let after = await second.snapshot()
        const finish = Date.now() + 180000
        while (
          (!after.attempts.some((attempt) => attempt.disposition === "ready") ||
            replies.length < 2 ||
            after.sessions.some((session) => session.running)) &&
          !errors.length &&
          !model.errors.length &&
          Date.now() < finish
        ) {
          await Bun.sleep(100)
          after = await second.snapshot()
        }
        expect({ errors, modelErrors: model.errors }).toEqual({ errors: [], modelErrors: [] })
        expect({
          controls: after.cases.map((record) => record.control),
          dispositions: after.attempts.map((attempt) => attempt.disposition),
          actions: after.actions.map((action) => [action.operation, action.state]),
        }).toEqual({
          controls: ["active"],
          dispositions: repair ? ["superseded", "ready"] : ["ready"],
          actions: after.actions.map((action) => [action.operation, "acknowledged"]),
        })
        expect(after.runs).toHaveLength(repair ? 4 : 2)
        expect(after.reviews).toHaveLength(repair ? 2 : 1)
        expect(after.assignments).toHaveLength(repair ? 8 : 4)
        expect(after.assignments.every((assignment) => !!assignment.acceptedReportId)).toBe(true)
        for (const session of before.sessions) {
          const resumed = after.sessions.find((item) => item.id === session.id)
          expect(resumed?.roots).toEqual(session.roots)
          expect(resumed?.workspace).toBe(session.workspace)
        }
        const attempt = after.attempts.find((attempt) => attempt.id === after.cases[0].activeAttemptId)!
        expect(attempt.candidateSha).toBe(candidate)
        expect(
          after.runs
            .filter((run) => run.attemptId === attempt.id)
            .map((run) => run.outcome)
            .sort(),
        ).toEqual(["failed", "passed"])
        expect(after.reviews.find((review) => review.attemptId === attempt.id)).toMatchObject({
          headSha: candidate,
          recommendation: "ready_for_human",
        })
        expect(github.calls.map((call) => call.operation)).toEqual([
          "ensure_issue",
          "ensure_draft",
          ...(repair ? (["publish_review", "refresh_pr"] as const) : []),
          "publish_review",
          "mark_ready",
        ])
        expect(after.actions.map((action) => action.operation)).toEqual(github.calls.map((call) => call.operation))
        expect(github.pull()).toMatchObject({ number: 55, headSha: candidate, draft: false })
        expect(github.calls.at(-1)?.body).toContain("```mermaid")
        if (repair) {
          expect(after.cases[0].repairRounds).toBe(1)
          expect(after.reviews.find((review) => review.attemptId !== attempt.id)?.findings[0]).toMatchObject({
            id: "attachment-copy",
            disposition: "open",
          })
          expect(after.reviews.find((review) => review.attemptId === attempt.id)?.findings[0]).toMatchObject({
            id: "attachment-copy",
            disposition: "resolved",
          })
          expect(
            after.reports.find((report) => report.attemptId === attempt.id && report.kind === "candidate")
              ?.addressedFindings,
          ).toEqual(["attachment-copy"])
        }
        expect(replies).toHaveLength(2)
        expect(replies[1]).toMatchObject({ messageId: "report" })
        expect(JSON.stringify(replies[1])).toContain("https://github.com/acme/oryn-fixture/pull/55")
        expect(JSON.stringify(replies[1])).toContain(candidate)
        expect(after.reactions).toBe(0)
        expect(after.streaming).toBe(0)
        await second.receive(message)
        expect(replies).toHaveLength(2)
        expect((await second.snapshot()).cases).toHaveLength(1)
        await second.crash()
        scenario = makeScenario()
        await using third = await runtimeProcess({ home: `${storage.path}/home`, boot })
        const settled = await third.snapshot()
        expect(settled.attempts.map((attempt) => [attempt.id, attempt.disposition])).toEqual(
          after.attempts.map((attempt) => [attempt.id, attempt.disposition]),
        )
        expect(settled.actions.map((action) => [action.id, action.state])).toEqual(
          after.actions.map((action) => [action.id, action.state]),
        )
        expect(settled.assignments.map((assignment) => assignment.id)).toEqual(
          after.assignments.map((assignment) => assignment.id),
        )
        expect(replies).toHaveLength(2)
        expect(github.calls).toHaveLength(repair ? 6 : 4)
      } finally {
        release.resolve()
        await broker.stop(true)
      }
    },
    420000,
  )
