import { migrateOrynStepBudgets } from "../../src/config/migration"
import { parse } from "jsonc-parser"
import { expect, test } from "bun:test"
import { OrynBudget } from "../../src/oryn/budget"
import { OrynStore } from "../../src/oryn/store"
import { globalConfig, tmpdir } from "./fixture"

test("step budgets exclude Case age and persist cumulative execution across retries", async () => {
  await using home = await tmpdir()
  await using config = await globalConfig({
    oryn: {
      enabled: true,
      routes: [{ feishuAccount: "test", repoAlias: "fixture" }],
      repositories: { fixture: { owner: "acme", repo: "fixture" } },
      limits: { maxStepMinutes: 360 },
    },
  })
  const record = await OrynStore.createCase({
    caseId: crypto.randomUUID(),
    kind: "bug",
    summary: "step budget",
    repoAlias: "fixture",
    sourceKeyHash: "budget-fixture",
  })
  const old = await OrynStore.mutateCase(record.id, record.revision, (value) => ({
    ...value,
    createdAt: Date.now() - 10 * 86400_000,
  }))
  expect(await OrynBudget.reason(old)).toBeUndefined()
  await OrynBudget.record({
    caseId: record.id,
    step: "attempt:review:general",
    executionId: "first",
    elapsedMs: 200 * 60_000,
  })
  await OrynBudget.record({
    caseId: record.id,
    step: "attempt:review:general",
    executionId: "first",
    elapsedMs: 200 * 60_000,
  })
  await OrynBudget.record({
    caseId: record.id,
    step: "attempt:review:security",
    executionId: "parallel",
    elapsedMs: 200 * 60_000,
  })
  expect(await OrynBudget.reason(old)).toBeUndefined()
  await OrynBudget.record({
    caseId: record.id,
    step: "attempt:review:general",
    executionId: "retry",
    elapsedMs: 161 * 60_000,
  })
  expect(await OrynBudget.reason(old)).toContain("360 minutes")
  expect((await OrynBudget.steps(record.id)).find((step) => step.step === "attempt:review:general")?.elapsedMs).toBe(
    361 * 60_000,
  )
})

test("step limit migration preserves explicit limits and unrelated settings on repeated upgrade", async () => {
  await using home = await tmpdir()
  const file = `${home.path}/120-runtime.jsonc`
  for (const explicit of [undefined, 480]) {
    const config = {
      oryn: {
        enabled: true,
        limits: { maxCaseMinutes: 180, maxActiveCases: 12, ...(explicit ? { maxStepMinutes: explicit } : {}) },
      },
      server: { port: 4098 },
    }
    await Bun.write(file, `// keep operator note\n${JSON.stringify(config)}`)
    await migrateOrynStepBudgets(file)
    const migrated = await Bun.file(file).text()
    expect(migrated).toContain("// keep operator note")
    expect(parse(migrated).oryn.limits).toEqual({ maxActiveCases: 12, maxStepMinutes: explicit ?? 360 })
    await migrateOrynStepBudgets(file)
    expect(await Bun.file(file).text()).toBe(migrated)
  }
  await migrateOrynStepBudgets(`${home.path}/absent.jsonc`)
})
