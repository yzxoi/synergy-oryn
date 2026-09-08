import { afterEach, describe, expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { OrynService } from "../../src/oryn/service"
import { OrynStore, sourceKey } from "../../src/oryn/store"
import { OrynPath } from "../../src/oryn/path"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "./fixture"
import { migrations } from "../../src/oryn/migration"
import { MigrationRegistry } from "../../src/migration/registry"

afterEach(() => OrynService.setOutboxDeliverer(undefined))

async function fixture(fn: (sessionID: string) => Promise<void>) {
  await using tmp = await tmpdir({
    config: {
      oryn: {
        enabled: true,
        routes: [{ feishuAccount: "outbox", repoAlias: "widget" }],
        repositories: { widget: { owner: "acme", repo: "widget", baseBranch: "dev" } },
      },
    },
  })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  await ScopeContext.provide({
    scope,
    fn: async () => {
      const sessionID = `qa_${crypto.randomUUID()}`
      const identity = { provider: "feishu" as const, accountId: "outbox", chatId: sessionID, messageId: "first" }
      await OrynStore.recordSource({ identity })
      await OrynStore.bindSessionSource({ sessionID, identity, role: "qa" })
      await fn(sessionID)
    },
  })
}

describe("Oryn notification delivery", () => {
  test("answers deduplicate within a root turn and later questions still receive answers", async () => {
    await fixture(async (callerSessionID) => {
      const first = await OrynService.reply({
        callerSessionID,
        turnID: "question-1",
        kind: "answer",
        text: "First answer",
      })
      const replay = await OrynService.reply({ callerSessionID, turnID: "question-1", kind: "answer", text: "Retry" })
      const second = await OrynService.reply({
        callerSessionID,
        turnID: "question-2",
        kind: "answer",
        text: "Second answer",
      })
      expect(replay.entryId).toBe(first.entryId)
      expect(replay.created).toBe(false)
      expect(second.created).toBe(true)
      expect(second.entryId).not.toBe(first.entryId)
    })
  })

  test("QA cannot send a notification for an unlinked case", async () => {
    await fixture(async (callerSessionID) => {
      const foreign = { provider: "feishu" as const, accountId: "outbox", chatId: "foreign", messageId: "foreign" }
      const record = await OrynStore.createCase({
        caseId: `case_${crypto.randomUUID()}`,
        kind: "bug",
        summary: "Private",
        repoAlias: "widget",
        sourceKeyHash: sourceKey(foreign),
      })
      await expect(
        OrynService.reply({ callerSessionID, caseId: record.id, kind: "accepted", text: "Leak" }),
      ).rejects.toMatchObject({ data: { code: "NOT_AUTHORIZED" } })
    })
  })

  test("concurrent identical notification intents create one record", async () => {
    await fixture(async (callerSessionID) => {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => OrynService.reply({ callerSessionID, kind: "accepted", text: "Accepted" })),
      )
      expect(new Set(results.map((r) => r.entryId)).size).toBe(1)
      expect(results.filter((r) => r.created)).toHaveLength(1)
    })
  })

  test("concurrent drains send each accepted intent only once", async () => {
    await fixture(async (callerSessionID) => {
      const reply = await OrynService.reply({ callerSessionID, kind: "accepted", text: "Accepted" })
      let sends = 0
      OrynService.setOutboxDeliverer(async ({ identity }) => {
        if (identity.chatId !== callerSessionID) return
        sends++
        await Bun.sleep(10)
      })
      await Promise.all([OrynService.drainOutbox(), OrynService.drainOutbox()])
      expect(sends).toBe(1)
      expect(await Storage.read(OrynPath.outbox(reply.entryId))).toMatchObject({ state: "delivered" })
    })
  })

  test("an uncertain send is never replayed by a later drain", async () => {
    await fixture(async (callerSessionID) => {
      const reply = await OrynService.reply({ callerSessionID, kind: "accepted", text: "Accepted" })
      let sends = 0
      OrynService.setOutboxDeliverer(async ({ identity }) => {
        if (identity.chatId !== callerSessionID) return
        sends++
        throw new Error("response lost after remote accepted")
      })
      await OrynService.drainOutbox()
      await OrynService.drainOutbox()
      expect(sends).toBe(1)
      expect(await Storage.read(OrynPath.outbox(reply.entryId))).toMatchObject({ state: "ambiguous" })
    })
  })

  test("a missing transport keeps a definitely unsent intent pending", async () => {
    await fixture(async (callerSessionID) => {
      const reply = await OrynService.reply({ callerSessionID, kind: "accepted", text: "Accepted" })
      await OrynService.drainOutbox()
      expect(await Storage.read(OrynPath.outbox(reply.entryId))).toMatchObject({ state: "pending" })
    })
  })

  test("restart preserves uncertainty recorded before the transport call", async () => {
    await fixture(async (callerSessionID) => {
      const reply = await OrynService.reply({ callerSessionID, kind: "accepted", text: "Accepted" })
      await OrynStore.claimOutboxDelivery(reply.entryId)
      let sends = 0
      OrynService.setOutboxDeliverer(async ({ identity }) => {
        if (identity.chatId === callerSessionID) sends++
      })
      await OrynService.drainOutbox()
      expect(sends).toBe(0)
      expect(await Storage.read(OrynPath.outbox(reply.entryId))).toMatchObject({ state: "ambiguous" })
    })
  })

  test("upgrade preserves old receipts and quarantines possibly sent pending entries", async () => {
    await fixture(async (callerSessionID) => {
      const binding = await OrynStore.sessionSourceBinding(callerSessionID)
      const ids: string[] = []
      for (const state of ["pending", "delivered", "suppressed"] as const) {
        const id = `legacy_${crypto.randomUUID()}`
        ids.push(id)
        await Storage.write(OrynPath.outbox(id), {
          schemaVersion: 1,
          id,
          sourceKey: binding!.sourceKey,
          kind: "accepted",
          text: "Old message",
          state,
          dedupKey: id,
          createdAt: 100,
          ...(state === "delivered" ? { deliveredAt: 101 } : {}),
        })
      }
      const migration = migrations.find((m) => m.id === "20260908-oryn-outbox-dispatch")
      expect(migration).toBeDefined()
      expect(MigrationRegistry.list().get("oryn")).toContain(migration!)
      await migration!.up(() => {})
      const first = await Promise.all(ids.map((id) => Storage.read(OrynPath.outbox(id))))
      expect(first[0]).toMatchObject({ schemaVersion: 2, state: "ambiguous" })
      expect(first[1]).toMatchObject({ schemaVersion: 2, state: "delivered", deliveredAt: 101 })
      expect(first[2]).toMatchObject({ schemaVersion: 2, state: "suppressed" })
      await migration!.up(() => {})
      expect(await Promise.all(ids.map((id) => Storage.read(OrynPath.outbox(id))))).toEqual(first)
    })
  })
})
