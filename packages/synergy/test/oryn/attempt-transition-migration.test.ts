import { expect, test } from "bun:test"
import { AttemptTransition } from "../../src/oryn/schema"
import { migrations } from "../../src/oryn/migration"
import { MigrationRegistry } from "../../src/migration/registry"
import { OrynPath } from "../../src/oryn/path"
import { Storage } from "../../src/storage/storage"

test("Attempt transition migration preserves v1 identities and is idempotent on old and fresh state", async () => {
  const migrate = migrations.find((entry) => entry.id === "20260908-oryn-attempt-transition-purpose")!
  expect(MigrationRegistry.list().get("oryn")).toContain(migrate)
  await migrate.up(() => {})
  const caseId = `fixture-transition-${crypto.randomUUID()}`
  const previous = "previous"
  const key = OrynPath.attemptTransition(caseId, previous)
  const legacy = {
    schemaVersion: 1 as const,
    input: {
      caseId,
      fromAttemptId: previous,
      nextBaselineSha: "b".repeat(40),
      invalidationReason: "preserved reason",
      countRepair: true,
      countNoProgress: false,
    },
    epoch: 3,
    expectedRevision: 7,
    repairRounds: 2,
    noProgressRounds: 0,
    next: {
      schemaVersion: 1 as const,
      id: "reserved-next",
      caseId,
      revision: 0,
      baselineSha: "b".repeat(40),
      baseBranchSha: "a".repeat(40),
      disposition: "open" as const,
      assignmentIds: [],
      evidenceRunIds: [],
      reviewIds: [],
      createdAt: 1,
      updatedAt: 1,
    },
  }
  await Storage.write(key, legacy)
  try {
    await migrate.up(() => {})
    const upgraded = AttemptTransition.parse(await Storage.read(key))
    expect(upgraded).toEqual({ ...legacy, schemaVersion: 2, kind: "rework", expectedControl: "active" })
    await migrate.up(() => {})
    expect(AttemptTransition.parse(await Storage.read(key))).toEqual(upgraded)
  } finally {
    await Storage.remove(key)
  }
})
