import { expect, test } from "bun:test"
import { join } from "node:path"
import { runOrynResourceCommand } from "../../src/oryn/resource-runner"
import { tmpdir } from "../fixture/fixture"

test("the trusted resource entry rejects commands outside their designated scope without writing success evidence", async () => {
  await using tmp = await tmpdir()
  const plan = join(tmp.path, "plan.json")
  const marker = join(tmp.path, "executed")
  const result = join(tmp.path, "result.json")
  await Bun.write(
    plan,
    JSON.stringify({
      unit: `oryn-command-${crypto.randomUUID()}.scope`,
      limits: { memoryMiB: 512, cpuQuotaPercent: 100, maxProcesses: 64 },
      result,
      command: process.execPath,
      args: ["--print", `Bun.write(${JSON.stringify(marker)}, "escaped")`],
      cwd: tmp.path,
      environment: {},
    }),
  )
  const exitCode = process.exitCode ?? 0
  try {
    await runOrynResourceCommand(plan)
    expect(process.exitCode).toBe(78)
    expect(await Bun.file(marker).exists()).toBe(false)
    expect(await Bun.file(result).exists()).toBe(false)
  } finally {
    process.exitCode = exitCode
  }
})
