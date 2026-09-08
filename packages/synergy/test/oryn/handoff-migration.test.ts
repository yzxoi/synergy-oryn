import { expect, test } from "bun:test"
import { Storage } from "../../src/storage/storage"
import { OrynStore } from "../../src/oryn/store"
import { OrynPath } from "../../src/oryn/path"
import { Case } from "../../src/oryn/schema"
import { migrations } from "../../src/oryn/migration"
import { MigrationRegistry } from "../../src/migration/registry"

test("handoff migration preserves legacy ownership without guessing a reason and retains fresh outcomes", async () => {
  const migration = migrations.find((entry) => entry.id === "20260908-oryn-handoff-outcome")!
  expect(MigrationRegistry.list().get("oryn")).toContain(migration)
  await migration.up(() => {})
  const input = { kind: "bug" as const, summary: "Attachment", repoAlias: "fixture", sourceKeyHash: "source" }
  const fresh = await OrynStore.createCase({ ...input, caseId: `fresh_${crypto.randomUUID()}` })
  const handed = await OrynStore.requestHandoff(fresh.id, "Need the failing input")
  const legacy = {
    ...(await OrynStore.createCase({ ...input, caseId: `legacy_${crypto.randomUUID()}` })),
    schemaVersion: 1,
    control: "human_owned" as const,
  }
  await Storage.write(OrynPath.caseInfo(legacy.id), legacy)
  await migration.up(() => {})
  expect(await OrynStore.getCase(legacy.id)).toEqual({ ...legacy, schemaVersion: 2 })
  expect(Case.parse(await OrynStore.getCase(legacy.id)).handoff).toBeUndefined()
  expect(await OrynStore.getCase(fresh.id)).toEqual(handed)
  await migration.up(() => {})
  expect(await OrynStore.getCase(fresh.id)).toEqual(handed)
  expect(await OrynStore.getCase(legacy.id)).toEqual({ ...legacy, schemaVersion: 2 })
})
