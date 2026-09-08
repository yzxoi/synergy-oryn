import { expect, test } from "bun:test"
import { OrynConfig } from "../../src/oryn/config"
import { OrynResources } from "../../src/oryn/resources"
import { SandboxBackend } from "../../src/sandbox/backend"
import { OrynSandbox } from "../../src/oryn/sandbox"
import { tmpdir } from "../fixture/fixture"

test.skipIf(process.platform === "linux")(
  "configured process resources cannot silently run without Linux cgroups",
  async () => {
    await using tmp = await tmpdir()
    const profile = {
      commandAllowlist: ["bun"],
      resourceLimits: { memoryMiB: 512, cpuQuotaPercent: 100, maxProcesses: 64 },
    }
    await expect(
      OrynSandbox.execute({
        argv: ["bun", "-e", "console.log('unbounded')"],
        cwd: tmp.path,
        timeoutMs: 5000,
        abort: new AbortController().signal,
        profile,
      }),
    ).rejects.toMatchObject({ data: { code: "ENVIRONMENT_UNAVAILABLE" } })
  },
)

test("installation process ceilings bound every repository execution profile", () => {
  const config = {
    enabled: true,
    repositories: { repo: { owner: "example", repo: "fixture" } },
    limits: { processResources: { memoryMiB: 1024, cpuQuotaPercent: 200, maxProcesses: 64 } },
    executionProfiles: {
      inherited: { commandAllowlist: ["bun"] },
      requested: {
        commandAllowlist: ["bun"],
        resourceLimits: { memoryMiB: 512, cpuQuotaPercent: 400, maxProcesses: 128 },
      },
    },
  }
  const profiles = OrynConfig.profiles(config, "repo")
  expect(profiles.inherited.resourceLimits).toEqual({ ...config.limits.processResources, maxSeconds: 1800 })
  expect(profiles.requested.resourceLimits).toEqual({
    maxSeconds: 1800,
    memoryMiB: 512,
    cpuQuotaPercent: 200,
    maxProcesses: 64,
  })
})

const native = process.platform === "linux" && process.env.SYNERGY_TEST_ORYN_CGROUP === "1"
const profile = {
  commandAllowlist: ["bun"],
  resourceLimits: { memoryMiB: 512, cpuQuotaPercent: 100, maxProcesses: 64 },
  requiredCapabilities: ["cgroup" as const],
}

test.skipIf(!native)(
  "native cgroup checks enforce resources while preserving the sandbox environment",
  async () => {
    await using tmp = await tmpdir()
    const result = await OrynSandbox.execute({
      argv: [
        "bun",
        "-e",
        "console.log(JSON.stringify({answer:42,bus:process.env.DBUS_SESSION_BUS_ADDRESS,runtime:process.env.XDG_RUNTIME_DIR}))",
      ],
      cwd: tmp.path,
      timeoutMs: 15000,
      abort: new AbortController().signal,
      profile,
    })
    expect(result.exitCode, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ answer: 42 })
  },
  30000,
)

test.skipIf(!native)(
  "memory exhaustion is an environment failure instead of product evidence",
  async () => {
    await using tmp = await tmpdir()
    await expect(
      OrynSandbox.execute({
        argv: [
          "bun",
          "-e",
          "const held=[];for(let n=0;n<1024;n++){held.push(Buffer.alloc(1024*1024,1));await Bun.sleep(2)}console.log(held.length)",
        ],
        cwd: tmp.path,
        timeoutMs: 15000,
        abort: new AbortController().signal,
        profile,
      }),
    ).rejects.toMatchObject({ data: { code: "ENVIRONMENT_UNAVAILABLE" } })
  },
  30000,
)

test.skipIf(!native)(
  "task-count exhaustion cannot produce trusted success",
  async () => {
    await using tmp = await tmpdir()
    await expect(
      OrynSandbox.execute({
        argv: [
          "bun",
          "-e",
          "const children=[];for(let n=0;n<100;n++){try{children.push(Bun.spawn(['/bin/sleep','0.5']))}catch{break}}await Promise.all(children.map(p=>p.exited))",
        ],
        cwd: tmp.path,
        timeoutMs: 15000,
        abort: new AbortController().signal,
        profile,
      }),
    ).rejects.toMatchObject({ data: { code: "ENVIRONMENT_UNAVAILABLE" } })
  },
  30000,
)

test.skipIf(!native)(
  "resource scope cancellation stops detached descendants and removes the owned scope",
  async () => {
    await using tmp = await tmpdir()
    const controller = new AbortController()
    const resources = await OrynResources.prepare({
      cwd: tmp.path,
      wrapper: {
        command: "/bin/sh",
        args: [
          "-c",
          'setsid /bin/sh -c \'while true; do echo tick >> "$1"; sleep 0.05; done\' probe "$1" & wait',
          "probe",
          `${tmp.path}/ticks`,
        ],
        sandboxed: false,
      },
      environment: { PATH: "/usr/bin:/bin", HOME: tmp.path },
      limits: profile.resourceLimits,
      abort: controller.signal,
    })
    const running = SandboxBackend.executeAsync(resources.wrapper, {
      cwd: tmp.path,
      env: resources.environment,
      inheritEnv: false,
      fallbackPolicy: "deny",
      signal: controller.signal,
      timeoutMs: 10000,
    })
    const settled = running.catch(() => undefined)
    try {
      for (let attempt = 0; attempt < 100 && !(await Bun.file(`${tmp.path}/ticks`).exists()); attempt++)
        await Bun.sleep(50)
      expect(await Bun.file(`${tmp.path}/ticks`).exists()).toBe(true)
      controller.abort()
      await settled
      await resources.dispose()
      const first = await Bun.file(`${tmp.path}/ticks`).text()
      await Bun.sleep(150)
      expect(await Bun.file(`${tmp.path}/ticks`).text()).toBe(first)
    } finally {
      controller.abort()
      await settled
      await resources.dispose()
    }
  },
  30000,
)

test.skipIf(!native)(
  "the trusted quota runner does not load candidate Bun startup configuration",
  async () => {
    await using candidate = await tmpdir()
    await using outside = await tmpdir()
    const marker = `${outside.path}/escaped`
    await Bun.write(`${candidate.path}/bunfig.toml`, 'preload = ["./preload.ts"]\n')
    await Bun.write(`${candidate.path}/.bunfig.toml`, 'preload = ["./preload.ts"]\n')
    await Bun.write(`${candidate.path}/preload.ts`, `await Bun.write(${JSON.stringify(marker)}, "escaped")`)
    const resources = await OrynResources.prepare({
      cwd: candidate.path,
      wrapper: { command: "/bin/true", args: [], sandboxed: false },
      environment: { PATH: "/usr/bin:/bin", HOME: candidate.path },
      limits: profile.resourceLimits,
      abort: new AbortController().signal,
    })
    try {
      const result = await SandboxBackend.executeAsync(resources.wrapper, {
        cwd: candidate.path,
        env: resources.environment,
        inheritEnv: false,
        fallbackPolicy: "deny",
        timeoutMs: 15000,
      })
      expect(result.exitCode, result.stderr).toBe(0)
      await resources.verify()
      expect(await Bun.file(marker).exists()).toBe(false)
    } finally {
      await resources.dispose()
    }
  },
  30000,
)

test.skipIf(!native)(
  "the scope watchdog bounds execution independently of the Host timeout",
  async () => {
    await using tmp = await tmpdir()
    const started = Date.now()
    await expect(
      OrynSandbox.execute({
        argv: ["bun", "-e", "await Bun.sleep(60000)"],
        cwd: tmp.path,
        timeoutMs: 15000,
        abort: new AbortController().signal,
        profile: { ...profile, resourceLimits: { ...profile.resourceLimits, maxSeconds: 2 } },
      }),
    ).rejects.toMatchObject({ data: { code: "ENVIRONMENT_UNAVAILABLE" } })
    expect(Date.now() - started).toBeLessThan(12000)
  },
  30000,
)
