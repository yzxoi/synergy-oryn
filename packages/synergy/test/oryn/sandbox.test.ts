import { expect, test } from "bun:test"
import { mkdir, symlink } from "node:fs/promises"
import { join } from "node:path"
import { OrynSandbox } from "../../src/oryn/sandbox"
import { OrynConfig } from "../../src/oryn/config"
import { Oryn } from "../../src/config/schema"

test("trusted local checks can write outside the checkout and use the network without a sandbox", async () => {
  await using dir = await tmpdir()
  const workspace = join(dir.path, "checkout")
  await mkdir(workspace)
  const output = join(dir.path, "outside.txt")
  const server = Bun.serve({ port: 0, fetch: () => new Response("connected") })
  try {
    const config = Oryn.parse({
      enabled: true,
      executionMode: "trusted_local",
      routes: [{ feishuAccount: "qa", repoAlias: "repo" }],
      repositories: { repo: { owner: "test", repo: "repo" } },
      executionProfiles: { check: { commandAllowlist: ["bun"] } },
    })
    const result = await OrynSandbox.execute({
      argv: [
        "bun",
        "-e",
        `await Bun.write(${JSON.stringify(output)}, await fetch(${JSON.stringify(server.url.href)}).then(r=>r.text()));`,
      ],
      cwd: workspace,
      timeoutMs: 5000,
      abort: new AbortController().signal,
      profile: OrynConfig.profiles(config, "repo").check,
    })
    expect(result.exitCode, result.stderr).toBe(0)
    expect(await Bun.file(output).text()).toBe("connected")
  } finally {
    server.stop(true)
  }
})
import { tmpdir } from "../fixture/fixture"

test("trusted local checks retain timeout, cancellation and explicit capability requirements", async () => {
  await using dir = await tmpdir()
  const marker = join(dir.path, "marker")
  const input = {
    argv: ["bun", "-e", `await Bun.write(${JSON.stringify(marker)}, 'ran')`],
    cwd: dir.path,
    timeoutMs: 100,
    abort: new AbortController().signal,
    profile: { isolation: "trusted_local" as const, commandAllowlist: ["bun"] },
  }
  await expect(OrynSandbox.execute({ ...input, abort: AbortSignal.abort() })).rejects.toBeDefined()
  await expect(
    OrynSandbox.execute({ ...input, profile: { ...input.profile, requiredCapabilities: ["namespace"] } }),
  ).rejects.toMatchObject({ data: { code: "ENVIRONMENT_UNAVAILABLE" } })
  expect(await Bun.file(marker).exists()).toBe(false)
  const result = await OrynSandbox.execute({ ...input, argv: ["bun", "-e", "setInterval(() => {}, 1000)"] })
  expect(result.timedOut).toBe(true)
})

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "Oryn experiments allow only selected build directories while source and metadata stay read-only",
  async () => {
    await using dir = await tmpdir()
    await mkdir(join(dir.path, "dist"))
    await mkdir(join(dir.path, ".git"))
    await Bun.write(join(dir.path, "source.txt"), "frozen")
    await Bun.write(join(dir.path, ".git", "config"), "protected")
    const result = await OrynSandbox.execute({
      argv: [
        "bun",
        "-e",
        `
        import {writeFileSync,symlinkSync} from 'node:fs';
        writeFileSync('dist/output.txt', 'built');
        symlinkSync('../source.txt','dist/escape');
        const denied=[];
        for(const file of ['source.txt','.git/config','unapproved.txt','dist/escape']) {
          try { writeFileSync(file,'changed') } catch { denied.push(file) }
        }
        console.log(JSON.stringify(denied));
      `,
      ],
      cwd: dir.path,
      writableRoots: [join(dir.path, "dist")],
      timeoutMs: 5000,
      abort: new AbortController().signal,
      profile: { commandAllowlist: ["bun"] },
    })
    expect(result.exitCode, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(["source.txt", ".git/config", "unapproved.txt", "dist/escape"])
    expect(await Bun.file(join(dir.path, "dist", "output.txt")).text()).toBe("built")
    expect(await Bun.file(join(dir.path, "source.txt")).text()).toBe("frozen")
  },
  10000,
)

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "Oryn checks preserve an ordinary nonzero process result",
  async () => {
    await using dir = await tmpdir()
    const result = await OrynSandbox.execute({
      argv: ["bun", "--print", "process.exit(1)"],
      cwd: dir.path,
      timeoutMs: 5000,
      abort: new AbortController().signal,
      profile: { commandAllowlist: ["bun"] },
    })
    expect(result.exitCode, result.stderr).toBe(1)
    expect(result.timedOut).toBe(false)
  },
  10000,
)

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "Oryn checks use a disposable home and deny candidate, sibling and host access",
  async () => {
    await using dir = await tmpdir()
    const workspace = join(dir.path, "candidate")
    await mkdir(workspace)
    await Bun.write(join(workspace, "source.txt"), "original")
    await Bun.write(join(dir.path, "secret.txt"), "fixture secret")
    await symlink(join(dir.path, "secret.txt"), join(workspace, "escape"))
    const script = `
    import {readFileSync,writeFileSync} from 'node:fs';
    const answer={home:process.env.HOME,token:process.env.GH_TOKEN??null,read:readFileSync('source.txt','utf8'),write:false,escape:false};
    writeFileSync(process.env.HOME+'/test-output','scratch');
    try {writeFileSync('source.txt','changed');answer.write=true} catch {}
    try {readFileSync('escape');answer.escape=true} catch {}
    console.log(JSON.stringify(answer));`
    const result = await OrynSandbox.execute({
      argv: ["bun", "-e", script],
      cwd: workspace,
      timeoutMs: 5000,
      abort: new AbortController().signal,
      profile: { commandAllowlist: ["bun"] },
    })
    expect(result.exitCode, result.stderr).toBe(0)
    const answer = JSON.parse(result.stdout)
    expect(answer).toMatchObject({ token: null, read: "original", write: false, escape: false })
    expect(answer.home).not.toBe(process.env.HOME)
    expect(await Bun.file(join(answer.home, "test-output")).exists()).toBe(false)
    expect(await Bun.file(join(workspace, "source.txt")).text()).toBe("original")
  },
  10000,
)

test("unsupported isolation and capabilities fail before executing candidate code", async () => {
  await using dir = await tmpdir()
  const marker = join(dir.path, "executed")
  for (const profile of [
    { commandAllowlist: ["bun"], isolation: "worktree" as const },
    { commandAllowlist: ["bun"], isolation: "external_vm" as const },
    { commandAllowlist: ["bun"], requiredCapabilities: ["cgroup" as const] },
    { commandAllowlist: ["bun"], requiredCapabilities: ["network_egress" as const] },
  ]) {
    await expect(
      OrynSandbox.execute({
        argv: ["bun", "-e", `await Bun.write(${JSON.stringify(marker)},'executed')`],
        cwd: dir.path,
        timeoutMs: 5000,
        abort: new AbortController().signal,
        profile,
      }),
    ).rejects.toMatchObject({ data: { code: "ENVIRONMENT_UNAVAILABLE" } })
    expect(await Bun.file(marker).exists()).toBe(false)
  }
})
