import { expect, test } from "bun:test"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { OrynPath } from "../../src/oryn/path"
import { OrynStore } from "../../src/oryn/store"
import { LearningCandidate } from "../../src/oryn/schema"
import { migrations } from "../../src/oryn/migration"
import { runMigrations } from "../../src/migration"
import { OrynMemory } from "../../src/library/oryn-memory"
import { LibraryDB } from "../../src/library/database"

test("central migration preserves legacy memory bytes and identity without inventing provenance", async () => {
  const migrate = migrations.find((item) => item.id === "20260908-oryn-learning-provenance")!
  await migrate.up(() => {})
  const fresh = await OrynStore.writeLearning({
    caseId: "fixture-fresh-learning",
    lesson: "Fresh lesson",
    applicability: "fixture",
    invalidation: "new evidence",
    evidenceRefs: ["fresh-evidence"],
    memory: { title: "Fresh lesson", content: "Host-bound fixture" },
  })
  const legacy = {
    schemaVersion: 1,
    id: `orl_legacy_${crypto.randomUUID()}`,
    caseId: "fixture-legacy-learning",
    outcomeVersion: "model-supplied-v1",
    lesson: "A historical lesson",
    applicability: "legacy candidate",
    invalidation: "new evidence",
    evidenceRefs: [],
    promotionState: "promoted",
    memoryRef: `mem_legacy_${crypto.randomUUID()}`,
    createdAt: 1,
    updatedAt: 2,
  }
  const memory = {
    title: legacy.lesson,
    content:
      "Lesson: A historical lesson\nApplies to: legacy candidate\nInvalid when: new evidence\nEvidence (case-scoped records): \nVerified at outcome version: model-supplied-v1",
  }
  await Storage.write(OrynPath.learning(legacy.id), legacy)
  LibraryDB.Memory.insert(
    { id: legacy.memoryRef, ...memory, category: "knowledge", recallMode: "contextual" },
    { id: legacy.memoryRef, model: "fixture", vector: [1, 0, 0, 0, 0, 0, 0, 0] },
  )
  const trackingKey = StoragePath.metaMigrationLogDomain("oryn")
  const tracking = await Storage.read<Record<string, number>>(trackingKey).catch(() => ({}))
  try {
    await Storage.write(trackingKey, Object.fromEntries(Object.entries(tracking).filter(([id]) => id !== migrate.id)))
    expect((await runMigrations({ targetDomain: "oryn", output: "silent" })).failed).toBe(0)
    const migrated = LearningCandidate.parse(await OrynStore.getLearning(legacy.id))
    expect(migrated.source).toBeUndefined()
    expect(migrated.memory).toEqual(memory)
    expect(migrated.memoryRef).toBe(legacy.memoryRef)
    expect(migrated.createdAt).toBe(legacy.createdAt)
    expect(migrated.updatedAt).toBe(legacy.updatedAt)
    expect(await OrynStore.getLearning(fresh.id)).toEqual(fresh)
    await migrate.up(() => {})
    expect(await OrynStore.getLearning(legacy.id)).toEqual(migrated)
    expect(await OrynStore.getLearning(fresh.id)).toEqual(fresh)
    await OrynMemory.remove(migrated.memoryRef!, migrated.memory)
    expect(LibraryDB.Memory.get(legacy.memoryRef)).toBeNull()
  } finally {
    LibraryDB.Memory.remove(legacy.memoryRef)
    await Storage.remove(OrynPath.learning(legacy.id))
    await Storage.remove(OrynPath.learning(fresh.id))
    await Storage.write(trackingKey, tracking)
  }
})
