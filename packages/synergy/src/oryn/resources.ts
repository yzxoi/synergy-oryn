import { existsSync } from "node:fs"
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { SandboxExecutionWrapper } from "../sandbox/types"
import { OrynProcessResources, OrynResourceResult } from "./resource-policy"
import { storeError } from "./store"

const runner = fileURLToPath(new URL("./resource-runner.ts", import.meta.url))

export namespace OrynResources {
  export async function prepare(input: {
    wrapper: SandboxExecutionWrapper
    cwd: string
    environment: Record<string, string>
    limits?: OrynProcessResources
    abort: AbortSignal
  }) {
    const noop = async () => {}
    if (!input.limits) return { wrapper: input.wrapper, environment: input.environment, verify: noop, dispose: noop }
    input.abort.throwIfAborted()
    const limits = OrynProcessResources.parse(input.limits)
    if (process.platform !== "linux" || !existsSync("/sys/fs/cgroup/cgroup.controllers"))
      throw storeError("ENVIRONMENT_UNAVAILABLE", "Configured process resources require Linux cgroup v2")
    const runtime = `/run/user/${process.getuid!()}`
    const socket = await lstat(join(runtime, "bus")).catch(() => undefined)
    if (
      !socket?.isSocket() ||
      socket.uid !== process.getuid!() ||
      !existsSync("/usr/bin/systemd-run") ||
      !existsSync("/usr/bin/systemctl")
    )
      throw storeError(
        "ENVIRONMENT_UNAVAILABLE",
        "Configured process resources require an available user systemd manager",
      )
    const directory = await realpath(await mkdtemp(join(tmpdir(), "oryn-resources-")))
    const unit = `oryn-command-${crypto.randomUUID()}.scope`
    const environment = {
      PATH: input.environment.PATH ?? "/usr/bin:/bin",
      LANG: "C.UTF-8",
      HOME: directory,
      TMPDIR: directory,
      TMP: directory,
      TEMP: directory,
      XDG_RUNTIME_DIR: runtime,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
    }
    const controlEnvironment = {
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      XDG_RUNTIME_DIR: runtime,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
    }
    const result = join(directory, "result.json")
    const plan = join(directory, "plan.json")
    let disposal: Promise<void> | undefined
    async function control(args: string[]) {
      const child = Bun.spawn(["/usr/bin/systemctl", "--user", "--no-ask-password", ...args], {
        env: controlEnvironment,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        timeout: 10000,
        killSignal: "SIGKILL",
      })
      const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()])
      if (code !== 0)
        throw storeError("ENVIRONMENT_UNAVAILABLE", "Owned resource scope could not be inspected or stopped")
      return output.trim()
    }
    const dispose = () =>
      (disposal ??= (async () => {
        const state = await control(["show", "--property=LoadState", "--value", unit])
        if (state !== "not-found") await control(["stop", unit])
        await rm(directory, { recursive: true, force: true })
      })())
    try {
      await Bun.write(
        plan,
        JSON.stringify({
          unit,
          limits,
          result,
          command: input.wrapper.command,
          args: input.wrapper.args,
          cwd: input.cwd,
          environment: input.environment,
        }),
      )
      input.abort.throwIfAborted()
      const command = existsSync(runner)
        ? [process.execPath, "run", runner]
        : [process.execPath, "__oryn-resource-runner"]
      return {
        // Scope mode preserves the owned child-process tree: https://github.com/systemd/systemd/blob/v249/man/systemd-run.xml
        wrapper: {
          ...input.wrapper,
          command: "/usr/bin/systemd-run",
          args: [
            "--user",
            "--scope",
            "--quiet",
            "--collect",
            "--no-ask-password",
            `--unit=${unit}`,
            `--property=MemoryMax=${limits.memoryMiB * 1024 * 1024}`,
            "--property=MemorySwapMax=0",
            `--property=CPUQuota=${limits.cpuQuotaPercent}%`,
            `--property=TasksMax=${limits.maxProcesses}`,
            "--property=TimeoutStopSec=2s",
            `--property=RuntimeMaxSec=${limits.maxSeconds ?? 1800}s`,
            "--",
            "/usr/bin/env",
            `--chdir=${directory}`,
            "--",
            ...command,
            plan,
          ],
        },
        environment,
        async verify() {
          const report = OrynResourceResult.safeParse(
            await Bun.file(result)
              .json()
              .catch(() => undefined),
          )
          if (!report.success || JSON.stringify(report.data.limits) !== JSON.stringify(limits) || report.data.exhausted)
            throw storeError(
              "ENVIRONMENT_UNAVAILABLE",
              "Process resources were unavailable, exceeded or execution did not complete",
            )
        },
        dispose,
      }
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }
}
