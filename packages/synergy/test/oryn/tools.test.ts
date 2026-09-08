import { expect, test } from "bun:test"
import { z } from "zod"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Provider } from "../../src/provider/provider"
import { ProviderTransform } from "../../src/provider/transform"
import { OrynCaseTool, OrynResultTool, registerOrynTools } from "../../src/oryn/tools"
import { OrynStore, sourceKey } from "../../src/oryn/store"
import { OrynPath } from "../../src/oryn/path"
import { Storage } from "../../src/storage/storage"
import type { Tool } from "../../src/tool/tool"
import { tmpdir } from "./fixture"

test("every Oryn tool survives the production provider schema transformation", async () => {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  await ScopeContext.provide({
    scope,
    fn: async () => {
      const model = Provider.Model.parse({
        id: "fixture",
        providerID: "openai",
        name: "Fixture",
        api: { id: "fixture", url: "https://example.invalid", npm: "@ai-sdk/openai" },
        capabilities: Provider.mergeModelCapabilities({}),
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 10000, output: 1000 },
        status: "active",
        options: {},
        headers: {},
        release_date: "2026-09-08",
      })
      for (const definition of registerOrynTools()) {
        const tool = await definition.init()
        const schema = z.toJSONSchema(tool.parameters)
        expect(() => ProviderTransform.schema(model, schema, { tool: definition.id })).not.toThrow()
        expect(schema.type).toBe("object")
      }
    },
  })
})

function context(sessionID: string): Tool.Context {
  return {
    sessionID,
    messageID: "message",
    agent: "oryn-code",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  }
}

test("case reads expose engineering startup gaps without exposing the checkout", async () => {
  await caseFixture(true, async ({ callerSessionID, own }) => {
    await Storage.write(OrynPath.engineeringStart(own), {
      schemaVersion: 1,
      caseId: own,
      sessionId: "ses_reserved",
      state: "blocked",
      reason: "repository_origin_mismatch",
      directory: "/private/repository",
      updatedAt: Date.now(),
    })
    const result = await (
      await OrynCaseTool.init()
    ).execute({ input: { action: "get", caseId: own } }, context(callerSessionID))
    expect(JSON.parse(result.output).engineering).toEqual({ state: "blocked", reason: "repository_origin_mismatch" })
    expect(result.output).not.toContain("/private/repository")
  })
})

async function caseFixture(
  enabled: boolean,
  fn: (input: { callerSessionID: string; own: string; other: string }) => Promise<void>,
) {
  await using tmp = await tmpdir({
    config: {
      oryn: enabled
        ? {
            enabled: true,
            routes: [{ feishuAccount: "tools", repoAlias: "widget" }],
            repositories: { widget: { owner: "acme", repo: "widget", baseBranch: "dev", testProfiles: ["quick"] } },
            executionProfiles: {
              quick: { commandAllowlist: ["bun"], writableDirectories: ["dist"] },
              other: { commandAllowlist: ["node"] },
            },
          }
        : { enabled: false },
    },
  })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const identity = { provider: "feishu" as const, accountId: "tools", chatId: crypto.randomUUID() }
      const own = `case_${crypto.randomUUID()}`
      const other = `case_${crypto.randomUUID()}`
      await OrynStore.recordSource({ identity })
      for (const caseId of [own, other]) {
        await OrynStore.createCase({
          caseId,
          kind: "bug",
          summary: caseId,
          repoAlias: "widget",
          sourceKeyHash: sourceKey(identity),
        })
        await OrynStore.linkSourceToCase(sourceKey(identity), caseId)
      }
      const callerSessionID = `worker_${crypto.randomUUID()}`
      await OrynStore.bindSessionSource({ sessionID: callerSessionID, identity, role: "worker", caseId: own })
      await fn({ callerSessionID, own, other })
    },
  })
}

test("disabled Oryn rejects a previously bound worker's case reads", async () => {
  await caseFixture(false, async ({ callerSessionID, own }) => {
    const tool = await OrynCaseTool.init()
    await expect(
      tool.execute({ input: { action: "get", caseId: own } }, context(callerSessionID)),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" })
  })
})

test("engineering can inspect its repository check profiles while QA cannot", async () => {
  await caseFixture(true, async ({ callerSessionID, own }) => {
    const tool = await OrynCaseTool.init()
    const read = () => tool.execute({ input: { action: "get", caseId: own } }, context(callerSessionID))
    expect(JSON.parse((await read()).output).executionProfiles).toEqual({
      quick: { commandAllowlist: ["bun"], writableDirectories: ["dist"] },
    })
    const binding = (await OrynStore.sessionSourceBinding(callerSessionID))!
    await OrynStore.bindSessionSource({ sessionID: callerSessionID, identity: binding.identity!, role: "qa" })
    expect(JSON.parse((await read()).output).executionProfiles).toBeUndefined()
  })
})

test("a worker cannot read a sibling case or amend its own acceptance", async () => {
  await caseFixture(true, async ({ callerSessionID, own, other }) => {
    const tool = await OrynCaseTool.init()
    await expect(
      tool.execute({ input: { action: "get", caseId: other } }, context(callerSessionID)),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" })
    const list = await tool.execute({ input: { action: "list" } }, context(callerSessionID))
    expect(JSON.parse(list.output).map((c: { caseId: string }) => c.caseId)).toEqual([own])
    await expect(
      tool.execute(
        { input: { action: "amend", caseId: own, expectedRevision: 0, expected: "Weakened" } },
        context(callerSessionID),
      ),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" })
  })
})

test("report reads reject a known report from another case", async () => {
  await caseFixture(true, async ({ callerSessionID, other }) => {
    const report = await OrynStore.writeWorkerReport({
      caseId: other,
      attemptId: "attempt",
      assignmentId: "assignment",
      requestKey: "report",
      epoch: 0,
      kind: "repro",
      outcome: "inconclusive",
      summary: "Private evidence",
    })
    const tool = await OrynResultTool.init()
    await expect(
      tool.execute({ input: { kind: "get", caseId: other, reportId: report.id } }, context(callerSessionID)),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" })
  })
})
