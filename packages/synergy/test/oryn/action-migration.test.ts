import { expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { MigrationRegistry } from "../../src/migration/registry"
import { migrations } from "../../src/oryn/migration"
import { OrynPath } from "../../src/oryn/path"
import { ActionReceipt } from "../../src/oryn/schema"
import { OrynStore } from "../../src/oryn/store"
import { tmpdir } from "./fixture"

test("action migration preserves legacy uncertainty and exact fresh targets on replay", async () => {
  await using tmp = await tmpdir()
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return await ScopeContext.provide({
    scope,
    fn: async () => {
      const migration = migrations.find((entry) => entry.id === "20260908-oryn-ready-target")!
      expect(MigrationRegistry.list().get("oryn")).toContain(migration)
      await migration.up(() => {})
      const legacyId = `legacy_${crypto.randomUUID()}`
      const legacy = {
        schemaVersion: 1,
        id: legacyId,
        caseId: "fixture",
        operation: "mark_ready",
        payloadDigest: "legacy",
        expectedHead: "a".repeat(40),
        expectedRevision: 1,
        epoch: 0,
        requestKey: "legacy-ready",
        state: "ambiguous",
        attempts: 0,
        createdAt: 100,
        updatedAt: 101,
        remoteRefs: { checkRunId: 99 },
      } as const
      await Storage.write(OrynPath.action(legacyId), legacy)
      const fresh = await OrynStore.writeAction({
        caseId: "fresh",
        operation: "mark_ready",
        payloadDigest: "new",
        expectedHead: "b".repeat(40),
        expectedRevision: 2,
        epoch: 0,
        requestKey: "fresh-ready",
        state: "prepared",
        readyTarget: {
          attemptId: "attempt",
          repository: "acme/widget",
          branch: "codex/oryn/fixture",
          baseBranch: "dev",
          deliveryCheck: true,
        },
        remoteRefs: { pullNumber: 55 },
      })
      expect(ActionReceipt.parse(fresh).schemaVersion).toBe(2)
      await migration.up(() => {})
      const upgraded = ActionReceipt.parse(await Storage.read<unknown>(OrynPath.action(legacyId)))
      expect(upgraded).toEqual({ ...legacy, schemaVersion: 2 })
      expect(upgraded.readyTarget).toBeUndefined()
      await migration.up(() => {})
      expect(await Storage.read<unknown>(OrynPath.action(legacyId))).toEqual(upgraded)
      expect(await OrynStore.getAction(fresh.id)).toEqual(fresh)
    },
  })
})
