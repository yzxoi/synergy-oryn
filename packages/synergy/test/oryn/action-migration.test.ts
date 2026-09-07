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
      const labelMigration = migrations.find((entry) => entry.id === "20260908-oryn-label-target")!
      expect(MigrationRegistry.list().get("oryn")).toContain(labelMigration)
      expect(MigrationRegistry.list().get("oryn")).toContain(migration)
      await migration.up(() => {})
      await labelMigration.up(() => {})
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
      expect(ActionReceipt.parse(fresh).schemaVersion).toBe(3)
      await migration.up(() => {})
      await labelMigration.up(() => {})
      const upgraded = ActionReceipt.parse(await Storage.read<unknown>(OrynPath.action(legacyId)))
      expect(upgraded).toEqual({ ...legacy, schemaVersion: 3 })
      expect(upgraded.readyTarget).toBeUndefined()
      await migration.up(() => {})
      await labelMigration.up(() => {})
      expect(await Storage.read<unknown>(OrynPath.action(legacyId))).toEqual(upgraded)
      expect(await OrynStore.getAction(fresh.id)).toEqual(fresh)
    },
  })
})

test("label migration upgrades v2 readiness receipts without inventing a label intent", async () => {
  await using tmp = await tmpdir()
  const migration = migrations.find((entry) => entry.id === "20260908-oryn-label-target")!
  const fresh = await OrynStore.writeAction({
    caseId: "label-migration",
    operation: "sync_labels",
    payloadDigest: "target",
    expectedRevision: 1,
    epoch: 0,
    requestKey: "labels",
    state: "in_flight",
    labelTarget: {
      repository: "acme/widget",
      kind: "issue",
      number: 12,
      baseBranch: "dev",
      labels: ["oryn:type/bug", "oryn:status/coding", "oryn:priority/untriaged"],
    },
    remoteRefs: { issueNumber: 12 },
  })
  const { labelTarget: _, ...legacyFields } = fresh
  const legacy = {
    ...legacyFields,
    id: `v2-${crypto.randomUUID()}`,
    schemaVersion: 2,
    operation: "mark_ready" as const,
    readyTarget: {
      repository: "acme/widget",
      branch: "codex/oryn/example",
      baseBranch: "dev",
      attemptId: "attempt",
      deliveryCheck: false,
    },
  }
  await Storage.write(OrynPath.action(legacy.id), legacy)
  await migration.up(() => {})
  const upgraded = ActionReceipt.parse(await OrynStore.getAction(legacy.id))
  expect(upgraded).toEqual({ ...legacy, schemaVersion: 3 })
  expect(upgraded.labelTarget).toBeUndefined()
  await migration.up(() => {})
  expect(await OrynStore.getAction(fresh.id)).toEqual(fresh)
})
