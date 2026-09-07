import { describe, expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Server } from "../../src/server/server"
import { OrynStore, sourceKey } from "../../src/oryn/store"
import { tmpdir } from "../fixture/fixture"

const orynEnabledConfig = {
  oryn: {
    enabled: true,
    routes: [{ feishuAccount: "acc_test", repoAlias: "acme/widget" }],
    repositories: { "acme/widget": { owner: "acme", repo: "widget", baseBranch: "dev" } },
  },
} as const

async function withScope<T>(config: Record<string, unknown> | undefined, fn: (scope: Scope) => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true, ...(config ? { config } : {}) })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn: () => fn(scope) })
}

async function seedCase(scope: Scope) {
  const identity = {
    provider: "feishu" as const,
    accountId: "acc_test",
    chatId: `chat_${Math.random().toString(36).slice(2, 8)}`,
    threadId: "thr_x",
    messageId: "msg_x",
  }
  const key = sourceKey(identity)
  const claim = await OrynStore.claimSource({ identity, requestKey: "rk_route" })
  await OrynStore.recordSource({ identity, qaScopeId: scope.id })
  const record = await OrynStore.createCase({
    caseId: claim.claim.caseId,
    kind: "bug",
    summary: "route seeded case",
    repoAlias: "acme/widget",
    sourceKeyHash: key,
    qaScopeId: scope.id,
  })
  return { record, key }
}

describe("oryn routes", () => {
  test("cases list is empty while oryn is disabled", async () => {
    await withScope(undefined, async (scope) => {
      await seedCase(scope)
      const app = Server.App()
      const response = await app.request("/oryn/cases", {
        headers: { "x-synergy-scope-id": scope.id },
      })
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.cases).toEqual([])
    })
  })

  test("enabled runtime lists, shows, and controls cases", async () => {
    await withScope(orynEnabledConfig, async (scope) => {
      const { record } = await seedCase(scope)
      const app = Server.App()
      const headers = { "x-synergy-scope-id": scope.id }

      const list = await app.request("/oryn/cases", { headers })
      expect(list.status).toBe(200)
      const listed = await list.json()
      const entry = listed.cases.find((c: { id: string }) => c.id === record.id)
      expect(entry).toMatchObject({ repoAlias: "acme/widget", control: "active", kind: "bug" })

      const detail = await app.request(`/oryn/cases/${record.id}`, { headers })
      expect(detail.status).toBe(200)
      const detailBody = await detail.json()
      expect(detailBody.summary).toBe("route seeded case")
      expect(detailBody.revision).toBe(record.revision)

      const stale = await app.request(`/oryn/cases/${record.id}/control`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: record.revision + 3, action: "pause" }),
      })
      expect(stale.status).toBe(409)

      const paused = await app.request(`/oryn/cases/${record.id}/control`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: record.revision, action: "pause" }),
      })
      expect(paused.status).toBe(200)
      const pausedBody = await paused.json()
      expect(pausedBody.control).toBe("paused")
      expect(pausedBody.revision).toBe(record.revision + 1)
    })
  })

  test("attempt endpoint returns 404 for unknown ids and 200 for existing attempts", async () => {
    await withScope(orynEnabledConfig, async (scope) => {
      const { record } = await seedCase(scope)
      const app = Server.App()
      const headers = { "x-synergy-scope-id": scope.id }

      const missing = await app.request(`/oryn/cases/${record.id}/attempts/orz_missing`, { headers })
      expect(missing.status).toBe(404)

      const attempt = await OrynStore.createAttempt({ caseId: record.id, baselineSha: "ff00" })
      const found = await app.request(`/oryn/cases/${record.id}/attempts/${attempt.id}`, { headers })
      expect(found.status).toBe(200)
      const attemptBody = await found.json()
      expect(attemptBody).toMatchObject({ caseId: record.id, baselineSha: "ff00", disposition: "open" })
    })
  })

  test("disabled runtime rejects control writes", async () => {
    await withScope(undefined, async (scope) => {
      const { record } = await seedCase(scope)
      const app = Server.App()
      const response = await app.request(`/oryn/cases/${record.id}/control`, {
        method: "POST",
        headers: { "x-synergy-scope-id": scope.id, "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: 0, action: "pause" }),
      })
      expect(response.status).toBe(404)
    })
  })
})
