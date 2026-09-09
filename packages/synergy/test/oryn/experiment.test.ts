import { expect, test } from "bun:test"
import { chmod, symlink } from "node:fs/promises"
import { join } from "node:path"
import { OrynExperiment } from "../../src/oryn/experiment"
import { OrynSandbox } from "../../src/oryn/sandbox"
import { tmpdir } from "../fixture/fixture"

test("a verification patch is materialized only in its fixed-commit experiment", async () => {
  await using repo = await repository()
  const patch =
    "diff --git a/test/regression.ts b/test/regression.ts\nnew file mode 100644\n--- /dev/null\n+++ b/test/regression.ts\n@@ -0,0 +1 @@\n+console.log('regression')\n"
  await using experiment = await OrynExperiment.prepare({
    source: repo.path,
    sha: repo.sha,
    profile: { commandAllowlist: ["bun"], dependencies: "none" },
    abort: new AbortController().signal,
    patch,
  })
  expect(await Bun.file(join(experiment.directory, "test/regression.ts")).text()).toContain("regression")
  expect(await Bun.file(join(repo.path, "test/regression.ts")).exists()).toBe(false)
  expect(await experiment.changed()).toBe(false)
  await Bun.write(join(experiment.directory, "test/regression.ts"), "changed\n")
  expect(await experiment.changed()).toBe(true)
})

async function repository() {
  const repo = await tmpdir({ git: true })
  try {
    await Bun.write(join(repo.path, "src", "main.ts"), "const answer: number = 42; console.log(answer)\n")
    await Bun.write(join(repo.path, "package.json"), '{"name":"oryn-build-fixture","private":true,"type":"module"}\n')
    await Bun.write(join(repo.path, "tsconfig.json"), '{"compilerOptions":{"target":"ESNext","module":"ESNext"}}\n')
    await Bun.write(join(repo.path, ".gitignore"), ".env\nnode_modules/\n")
    await Bun.write(join(repo.path, ".gitattributes"), "*.ts filter=fixture-evil\n")
    await symlink("src", join(repo.path, "linked"))
    await Bun.$`git add src package.json tsconfig.json .gitignore .gitattributes linked`.cwd(repo.path).quiet()
    await Bun.$`git -c core.hooksPath=/dev/null commit --no-gpg-sign -m fixture`.cwd(repo.path).quiet()
    const sha = (await Bun.$`git rev-parse HEAD`.cwd(repo.path).text()).trim()
    return { ...repo, sha }
  } catch (error) {
    await repo[Symbol.asyncDispose]()
    throw error
  }
}

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "an isolated experiment builds frozen TypeScript and shares only its own approved outputs",
  async () => {
    await using repo = await repository()
    await Bun.write(join(repo.path, ".env"), "private fixture configuration")
    await Bun.write(join(repo.path, "node_modules", "injected.js"), "untracked input")
    const marker = join(repo.path, "host-hook-ran")
    await Bun.$`git config filter.fixture-evil.smudge ${`touch '${marker}'`}`.cwd(repo.path).quiet()
    await Bun.write(join(repo.path, ".git", "hooks", "post-checkout"), `#!/bin/sh\ntouch '${marker}'\n`)
    await chmod(join(repo.path, ".git", "hooks", "post-checkout"), 0o755)
    const profile = { commandAllowlist: ["bun", "git"], writableDirectories: ["dist"] }
    const abort = new AbortController().signal
    let directory: string
    {
      await using experiment = await OrynExperiment.prepare({ source: repo.path, sha: repo.sha, profile, abort })
      directory = experiment.directory
      const run = (argv: string[]) =>
        OrynSandbox.execute({ ...experiment, argv, cwd: directory, timeoutMs: 10000, abort, profile })
      expect(await Bun.file(join(directory, ".env")).exists()).toBe(false)
      expect(await Bun.file(join(directory, "node_modules", "injected.js")).exists()).toBe(false)
      const build = await run([
        "bun",
        "-e",
        "const result=await Bun.build({entrypoints:['./src/main.ts'],target:'bun',outdir:'dist'});if(!result.success){console.error(result.logs);process.exit(1)}",
      ])
      expect(build.exitCode, build.stderr).toBe(0)
      const result = await run(["bun", "dist/main.js"])
      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.stdout.trim()).toBe("42")
      if (process.platform === "linux") {
        const cli = await run(["bun", "build", "src/main.ts", "--target=bun", "--outdir=dist/cli"])
        expect(cli.exitCode, cli.stderr).toBe(0)
        const built = await run(["bun", "dist/cli/main.js"])
        expect(built.exitCode, built.stderr).toBe(0)
        expect(built.stdout.trim()).toBe("42")
      }
      const version = await run(["git", "rev-parse", "HEAD"])
      expect(version.exitCode, version.stderr).toBe(0)
      expect(version.stdout.trim()).toBe(repo.sha)
      expect(await experiment.changed()).toBe(false)
      expect(await Bun.file(marker).exists()).toBe(false)
      expect(await Bun.file(join(repo.path, "dist", "main.js")).exists()).toBe(false)
      await using other = await OrynExperiment.prepare({ source: repo.path, sha: repo.sha, profile, abort })
      expect(other.directory).not.toBe(directory)
      expect(await Bun.file(join(other.directory, "dist", "main.js")).exists()).toBe(false)
    }
    expect(await Bun.file(join(directory, "dist", "main.js")).exists()).toBe(false)
  },
  30000,
)

test("experiment outputs cannot cover tracked source, metadata or symlink ancestors", async () => {
  await using repo = await repository()
  for (const path of ["src", "SRC", ".", "../escape", ".git/cache", "linked/output", "src/main.ts/output"]) {
    await expect(
      OrynExperiment.prepare({
        source: repo.path,
        sha: repo.sha,
        profile: { commandAllowlist: ["bun"], writableDirectories: [path] },
        abort: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ data: { code: "ENVIRONMENT_UNAVAILABLE" } })
  }
})
