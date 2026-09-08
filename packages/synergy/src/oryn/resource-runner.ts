import { readFile, realpath, statfs } from "node:fs/promises"
import { basename, join, relative } from "node:path"
import { OrynResourcePlan } from "./resource-policy"

async function bounded(path: string, limit: number) {
  const raw = (await readFile(path, "utf8")).trim()
  const value = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value > limit)
    throw new Error("Resource limit was not applied")
}

async function events(directory: string) {
  const memory = await readFile(join(directory, "memory.events"), "utf8")
  const pids = await readFile(join(directory, "pids.events"), "utf8")
  return [
    memory.match(/^oom(?:_kill)? (\d+)$/gm)?.some((line) => Number(line.split(" ")[1]) > 0),
    /^max ([1-9]\d*)$/m.test(pids),
  ].some(Boolean)
}

export async function runOrynResourceCommand(path: string) {
  try {
    const plan = OrynResourcePlan.parse(await Bun.file(path).json())
    const group = (await readFile("/proc/self/cgroup", "utf8"))
      .split("\n")
      .find((line) => line.startsWith("0::"))
      ?.slice(3)
    if (!group || basename(group) !== plan.unit || group.split("/").includes(".."))
      throw new Error("Resource scope identity did not match")
    const directory = await realpath(join("/sys/fs/cgroup", group))
    const part = relative("/sys/fs/cgroup", directory)
    if (!part || part.startsWith("../") || (await statfs(directory)).type !== 0x63677270)
      throw new Error("Resource scope is not on cgroup v2")
    await bounded(join(directory, "memory.max"), plan.limits.memoryMiB * 1024 * 1024)
    await bounded(join(directory, "memory.swap.max"), 0)
    await bounded(join(directory, "pids.max"), plan.limits.maxProcesses)
    const cpu = (await readFile(join(directory, "cpu.max"), "utf8")).trim().split(/\s+/).map(Number)
    if (
      cpu.length !== 2 ||
      cpu.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
      cpu[0] / cpu[1] > plan.limits.cpuQuotaPercent / 100
    )
      throw new Error("CPU quota was not applied")
    const child = Bun.spawn([plan.command, ...plan.args], {
      cwd: plan.cwd,
      env: plan.environment,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
    const code = await child.exited
    const exhausted = await events(directory)
    await Bun.write(plan.result, JSON.stringify({ complete: true, limits: plan.limits, exhausted }))
    process.exitCode = exhausted ? 78 : code
  } catch {
    process.stderr.write(
      "Oryn process resources could not be verified or completed; environment intervention is required.\n",
    )
    process.exitCode = 78
  }
}

if (import.meta.main) await runOrynResourceCommand(process.argv[2] ?? "")
