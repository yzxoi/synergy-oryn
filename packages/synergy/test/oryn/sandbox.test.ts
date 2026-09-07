import { expect, test } from "bun:test"
import { mkdir, symlink } from "node:fs/promises"
import { join } from "node:path"
import { OrynSandbox } from "../../src/oryn/sandbox"
import { tmpdir } from "../fixture/fixture"

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
