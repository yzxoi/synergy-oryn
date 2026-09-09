import { expect, test } from "bun:test"
import { join } from "node:path"
import { chmod, lstat, readlink, rm, symlink } from "node:fs/promises"
import { OrynDependencies } from "../../src/oryn/dependencies"
import { OrynSandbox } from "../../src/oryn/sandbox"
import { OrynExperiment } from "../../src/oryn/experiment"
import { OrynGit } from "../../src/oryn/git"
import { tmpdir } from "../fixture/fixture"
import yargs from "yargs/yargs"
import { OrynCommand } from "../../src/cli/cmd/oryn"

const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")

test("locked installs resolve each commit's workspace packages without borrowing an installed tree", async () => {
  await using repo = await tmpdir({ git: true })
  await Bun.write(
    join(repo.path, "package.json"),
    JSON.stringify({
      name: "fixture",
      workspaces: ["packages/*"],
      dependencies: { "@oryn-fixture/local": "workspace:*" },
    }),
  )
  await Bun.write(
    join(repo.path, "packages/local/package.json"),
    JSON.stringify({ name: "@oryn-fixture/local", version: "1.0.0", main: "index.js" }),
  )
  await Bun.write(join(repo.path, "packages/local/index.js"), "exports.answer = 42")
  await Bun.$`bun install --ignore-scripts`.cwd(repo.path).quiet()
  await Bun.$`git add package.json bun.lock packages`.cwd(repo.path).quiet()
  await Bun.$`git commit -m fixture`.cwd(repo.path).quiet()
  const sha = await OrynGit.read(repo.path, ["rev-parse", "HEAD"])
  await using experiment = await OrynExperiment.prepare({
    source: repo.path,
    sha,
    profile: { isolation: "trusted_local", commandAllowlist: ["bun"], dependencies: "install" },
    abort: new AbortController().signal,
  })
  const result = await Bun.$`bun -e ${"console.log(require('@oryn-fixture/local').answer)"}`
    .cwd(experiment.directory)
    .text()
  expect(result.trim()).toBe("42")
  expect(experiment.dependencies).toContain("locked:bun:")
  expect(await experiment.changed()).toBe(false)
})

test("experiments materialize a pinned dependency snapshot instead of borrowing host dependencies", async () => {
  await using repo = await tmpdir({ git: true })
  await using snapshot = await tmpdir()
  await Bun.write(join(repo.path, "package.json"), '{"name":"fixture","dependencies":{"fixture-math":"1.0.0"}}')
  await Bun.write(join(repo.path, "bun.lock"), '{"lockfileVersion":1}')
  await Bun.$`git add package.json bun.lock`.cwd(repo.path).quiet()
  await Bun.$`git -c core.hooksPath=/dev/null commit --no-gpg-sign -m fixture`.cwd(repo.path).quiet()
  const sha = await OrynGit.read(repo.path, ["rev-parse", "HEAD"])
  const content = "exports.answer = 42\n"
  const digest = hash(content)
  await Bun.write(join(snapshot.path, "blobs", digest), content)
  const manifest = JSON.stringify({
    schemaVersion: 1,
    platform: process.platform,
    arch: process.arch,
    bunVersion: Bun.version,
    inputs: await Promise.all(
      ["bun.lock", "package.json"].map(async (path) => ({
        path,
        object: await OrynGit.read(repo.path, ["rev-parse", `HEAD:${path}`]),
      })),
    ),
    roots: ["node_modules"],
    entries: [
      { kind: "file", path: "node_modules/fixture-math/index.js", digest, bytes: content.length, executable: false },
    ],
  })
  await Bun.write(join(snapshot.path, "manifest.json"), manifest)
  await using experiment = await OrynExperiment.prepare({
    source: repo.path,
    sha,
    profile: { commandAllowlist: ["bun"], dependencySnapshots: [{ directory: snapshot.path, digest: hash(manifest) }] },
    abort: new AbortController().signal,
  })
  expect(await Bun.file(join(experiment.directory, "node_modules", "fixture-math", "index.js")).text()).toBe(content)
})

async function fixture(extraFiles = 0, workspaces: unknown = ["packages/*"]) {
  const repo = await tmpdir({ git: true })
  const artifacts = await tmpdir()
  await Bun.write(join(repo.path, ".gitignore"), "node_modules/\n.synergy/\n.env\n")
  await Bun.write(
    join(repo.path, "package.json"),
    JSON.stringify({
      name: "fixture",
      private: true,
      workspaces,
      dependencies: { "fixture-math": "1.0.0", "fixture-local": "workspace:*" },
    }),
  )
  await Bun.write(join(repo.path, "bun.lock"), '{"lockfileVersion":1}')
  await Bun.write(join(repo.path, "tsconfig.json"), '{"compilerOptions":{"module":"ESNext"}}')
  await Bun.write(join(repo.path, "packages/local/package.json"), '{"name":"fixture-local","main":"index.js"}')
  await Bun.write(join(repo.path, "packages/local/index.js"), "exports.offset = 2")
  await Bun.write(
    join(repo.path, "src/main.ts"),
    'import { answer } from "fixture-math"; import { offset } from "fixture-local"; console.log(answer + offset)',
  )
  for (let index = 0; index < extraFiles; index++) {
    await Bun.write(join(repo.path, "src/listing", `${index}-${"entry".repeat(38)}.txt`), "")
  }
  await commit(repo.path)
  await Bun.write(join(repo.path, "node_modules/fixture-math/index.js"), "exports.answer = 40")
  await Bun.write(
    join(repo.path, "node_modules/fixture-math/package.json"),
    '{"name":"fixture-math","version":"1.0.0","main":"index.js"}',
  )
  await Bun.write(join(repo.path, "node_modules/.bin/fixture"), "#!/bin/sh\necho fixture\n")
  await chmod(join(repo.path, "node_modules/.bin/fixture"), 0o755)
  await symlink("../packages/local", join(repo.path, "node_modules/fixture-local"))
  await Bun.write(join(repo.path, ".env"), "private fixture data")
  const abort = new AbortController().signal
  const output = join(artifacts.path, "snapshot")
  const sealed = await OrynDependencies.seal({ source: repo.path, output, abort })
  const profile = {
    commandAllowlist: ["bun"],
    writableDirectories: ["dist"],
    dependencySnapshots: [{ directory: sealed.directory, digest: sealed.digest }],
  }
  return {
    repo,
    artifacts,
    sealed,
    profile,
    abort,
    prepare: async () =>
      OrynExperiment.prepare({
        source: repo.path,
        sha: await OrynGit.read(repo.path, ["rev-parse", "HEAD"]),
        profile,
        abort,
      }),
  }
}

async function commit(directory: string) {
  await Bun.$`git add .`.cwd(directory).quiet()
  await Bun.$`git -c core.hooksPath=/dev/null commit --no-gpg-sign -m fixture`.cwd(directory).quiet()
}

test("dependency sealing accepts complete Git trees larger than a diagnostic output buffer", async () => {
  const f = await fixture(4096)
  const listing = await OrynGit.read(f.repo.path, ["ls-tree", "-rz", "--full-tree", "HEAD"])
  expect(Buffer.byteLength(listing)).toBeGreaterThan(1024 * 1024)
  expect(listing).toContain(`src/listing/4095-${"entry".repeat(38)}.txt\0`)
  const manifest = await Bun.file(join(f.sealed.directory, "manifest.json")).json()
  expect(manifest.inputs.map((input: { path: string }) => input.path)).toContain("packages/local/package.json")
  expect(f.sealed.files).toBeGreaterThan(0)
})

test("object workspace declarations seal and invalidate when their catalog changes", async () => {
  const f = await fixture(0, { packages: ["packages/*"], catalog: { "fixture-math": "1.0.0" } })
  await using experiment = await f.prepare()
  expect(await Bun.file(join(experiment.directory, "node_modules/fixture-math/index.js")).text()).toContain("40")
  const path = join(f.repo.path, "package.json")
  const manifest = await Bun.file(path).json()
  manifest.workspaces.catalog["fixture-math"] = "2.0.0"
  await Bun.write(path, JSON.stringify(manifest))
  await commit(f.repo.path)
  await expect(f.prepare()).rejects.toMatchObject({ data: { code: "ENVIRONMENT_UNAVAILABLE" } })
})

test("malformed object workspace declarations are rejected", async () => {
  for (const workspaces of [{ catalog: {} }, { packages: [42] }, { packages: "packages/*" }]) {
    await expect(fixture(0, workspaces)).rejects.toMatchObject({ data: { code: "ENVIRONMENT_UNAVAILABLE" } })
  }
})

async function rewriteManifest(
  f: Awaited<ReturnType<typeof fixture>>,
  update: (manifest: {
    platform: string
    entries: Array<{ kind: string; path: string; target?: string; digest?: string }>
  }) => void,
) {
  const manifest = await Bun.file(join(f.sealed.directory, "manifest.json")).json()
  update(manifest)
  const content = JSON.stringify(manifest)
  await Bun.write(join(f.sealed.directory, "manifest.json"), content)
  f.profile.dependencySnapshots[0].digest = hash(content)
}

const unavailable = { data: { code: "ENVIRONMENT_UNAVAILABLE" } }

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "sealed registry and workspace dependencies build in the native sandbox without borrowing live installs",
  async () => {
    const f = await fixture()
    await Bun.write(
      join(f.repo.path, "node_modules/fixture-math/index.js"),
      "throw new Error('host dependency was borrowed')",
    )
    await using experiment = await f.prepare()
    expect(experiment.dependencies).toBe(f.sealed.digest)
    expect(await Bun.file(join(experiment.directory, ".env")).exists()).toBe(false)
    expect(await readlink(join(experiment.directory, "node_modules/fixture-local"))).toBe("../packages/local")
    expect((await lstat(join(experiment.directory, "node_modules/.bin/fixture"))).mode & 0o111).not.toBe(0)
    const run = (code: string) =>
      OrynSandbox.execute({
        ...experiment,
        cwd: experiment.directory,
        argv: ["bun", "-e", code],
        profile: f.profile,
        timeoutMs: 10000,
        abort: f.abort,
      })
    const build = await run(
      "const result=await Bun.build({entrypoints:['./src/main.ts'],target:'bun',outdir:'dist'});if(!result.success){console.error(result.logs);process.exit(1)}",
    )
    if (process.platform === "linux") {
      expect(build.exitCode, build.stderr).toBe(0)
      const result = await run("await import('./dist/main.js')")
      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.stdout.trim()).toBe("42")
    } else {
      expect(build.exitCode).not.toBe(0)
      expect(build.stderr).toContain("PermissionDenied")
    }
    const write = await run(
      "try { await Bun.write('node_modules/fixture-math/index.js','tampered'); process.exitCode=2 } catch { console.log('denied') }",
    )
    expect(write.exitCode, write.stderr).toBe(0)
    expect(write.stdout.trim()).toBe("denied")
    expect(await Bun.file(join(experiment.directory, "node_modules/fixture-math/index.js")).text()).toBe(
      "exports.answer = 40",
    )
    await expect(
      OrynExperiment.prepare({
        source: f.repo.path,
        sha: await OrynGit.read(f.repo.path, ["rev-parse", "HEAD"]),
        profile: { ...f.profile, writableDirectories: ["node_modules"] },
        abort: f.abort,
      }),
    ).rejects.toMatchObject(unavailable)
  },
  30000,
)

test("code-only changes reuse dependencies and workspace links bind to the new source", async () => {
  const f = await fixture()
  await Bun.write(join(f.repo.path, "packages/local/index.js"), "exports.offset = 3")
  await commit(f.repo.path)
  await using experiment = await f.prepare()
  expect(await Bun.file(join(experiment.directory, "node_modules/fixture-local/index.js")).text()).toBe(
    "exports.offset = 3",
  )
})

test.each(["bun.lock", "package.json", "packages/local/package.json"])(
  "changed %s requires a new snapshot",
  async (path) => {
    const f = await fixture()
    await Bun.write(join(f.repo.path, path), (await Bun.file(join(f.repo.path, path)).text()) + "\n")
    await commit(f.repo.path)
    await expect(f.prepare()).rejects.toMatchObject(unavailable)
  },
)

test("snapshot selection rejects an incompatible platform and ambiguous matches", async () => {
  const f = await fixture()
  f.profile.dependencySnapshots.push(f.profile.dependencySnapshots[0])
  await expect(f.prepare()).rejects.toMatchObject(unavailable)
  f.profile.dependencySnapshots.pop()
  await rewriteManifest(f, (manifest) => {
    manifest.platform = "unsupported"
  })
  await expect(f.prepare()).rejects.toMatchObject(unavailable)
})

test("manifest and blob tampering are detected before checks can run", async () => {
  const f = await fixture()
  await Bun.write(
    join(f.sealed.directory, "manifest.json"),
    (await Bun.file(join(f.sealed.directory, "manifest.json")).text()) + "\n",
  )
  await expect(f.prepare()).rejects.toMatchObject(unavailable)
  f.profile.dependencySnapshots[0].digest = hash(await Bun.file(join(f.sealed.directory, "manifest.json")).text())
  const manifest = await Bun.file(join(f.sealed.directory, "manifest.json")).json()
  await Bun.write(
    join(f.sealed.directory, "blobs", manifest.entries.find((entry: { kind: string }) => entry.kind === "file").digest),
    "corrupted",
  )
  await expect(f.prepare()).rejects.toMatchObject(unavailable)
})

test.each(["../../outside", "../.git/config"])(
  "pinned manifests cannot authorize unsafe dependency link %s",
  async (target) => {
    const f = await fixture()
    await rewriteManifest(f, (manifest) => {
      manifest.entries.find((entry) => entry.kind === "symlink")!.target = target
    })
    await expect(f.prepare()).rejects.toMatchObject(unavailable)
  },
)

test("dependency links cannot escape through a tracked source symlink", async () => {
  const f = await fixture()
  await symlink(f.artifacts.path, join(f.repo.path, "redirect"))
  await commit(f.repo.path)
  await rewriteManifest(f, (manifest) => {
    manifest.entries.find((entry) => entry.kind === "symlink")!.target = "../redirect"
  })
  await expect(f.prepare()).rejects.toMatchObject(unavailable)
})

test("sealing preserves existing outputs and cleans its failed output", async () => {
  const f = await fixture()
  const original = await Bun.file(join(f.sealed.directory, "manifest.json")).text()
  await expect(
    OrynDependencies.seal({ source: f.repo.path, output: f.sealed.directory, abort: f.abort }),
  ).rejects.toBeDefined()
  expect(await Bun.file(join(f.sealed.directory, "manifest.json")).text()).toBe(original)
  await symlink(f.artifacts.path, join(f.repo.path, "node_modules/escape"))
  const output = join(f.artifacts.path, "failed")
  await expect(OrynDependencies.seal({ source: f.repo.path, output, abort: f.abort })).rejects.toMatchObject(
    unavailable,
  )
  expect(await lstat(output).catch(() => undefined)).toBeUndefined()
  const controller = new AbortController()
  controller.abort(new Error("cancel fixture"))
  await expect(OrynDependencies.seal({ source: f.repo.path, output, abort: controller.signal })).rejects.toThrow(
    "cancel fixture",
  )
  expect(await lstat(output).catch(() => undefined)).toBeUndefined()
})

test("blob symlinks are rejected even if their target has the expected bytes", async () => {
  const f = await fixture()
  const manifest = await Bun.file(join(f.sealed.directory, "manifest.json")).json()
  const entry = manifest.entries.find((entry: { kind: string }) => entry.kind === "file")
  const blob = join(f.sealed.directory, "blobs", entry.digest)
  const content = await Bun.file(blob).text()
  await rm(blob)
  const external = join(f.artifacts.path, "external")
  await Bun.write(external, content)
  await symlink(external, blob)
  await expect(f.prepare()).rejects.toMatchObject(unavailable)
})

test("snapshot output cannot be redirected into the source by a parent symlink", async () => {
  const f = await fixture()
  await symlink(f.repo.path, join(f.artifacts.path, "redirect"))
  await expect(
    OrynDependencies.seal({ source: f.repo.path, output: join(f.artifacts.path, "redirect/snapshot"), abort: f.abort }),
  ).rejects.toMatchObject(unavailable)
  expect(await lstat(join(f.repo.path, "snapshot")).catch(() => undefined)).toBeUndefined()
})

test("the registered seal command writes its artifact and restores signal listeners after success and failure", async () => {
  const f = await fixture()
  const output = join(f.artifacts.path, "registered-cli")
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]
  const exitCode = process.exitCode ?? 0
  const invoke = () =>
    yargs(["oryn", "seal-dependencies", f.repo.path, output, "--json"])
      .command(OrynCommand)
      .exitProcess(false)
      .parseAsync()
  try {
    await invoke()
    const manifest = await Bun.file(join(output, "manifest.json")).text()
    expect(hash(manifest)).toBe(f.sealed.digest)
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before)
    await invoke()
    expect(process.exitCode).toBe(1)
    expect(await Bun.file(join(output, "manifest.json")).text()).toBe(manifest)
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before)
  } finally {
    process.exitCode = exitCode
  }
})

test("the product CLI seals dependencies and reports failures with a nonzero exit", async () => {
  const f = await fixture()
  const home = await tmpdir()
  const cli = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, "--conditions=browser", "src/index.ts", "oryn", ...args], {
      cwd: import.meta.dir + "/../..",
      env: { ...process.env, SYNERGY_HOME: home.path, SYNERGY_CWD: f.repo.path },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10000,
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { stdout, stderr, exitCode }
  }
  const help = await cli(["seal-dependencies", "--help"])
  expect(help.exitCode).toBe(0)
  for (const item of ["source", "output", "--json", "no installation"]) expect(help.stdout).toContain(item)
  const output = join(f.artifacts.path, "from-cli")
  const result = await cli(["seal-dependencies", f.repo.path, output, "--json"])
  expect(result.exitCode, result.stderr).toBe(0)
  const sealed = JSON.parse(result.stdout)
  expect(sealed.directory).toBe(output)
  expect(sealed.digest).toBe(f.sealed.digest)
  const failure = await cli(["seal-dependencies", f.repo.path, output, "--json"])
  expect(failure.exitCode).toBe(1)
  expect(failure.stdout).toBe("")
  expect(JSON.parse(failure.stderr).error).toBeString()
}, 30000)

test("copied local dependencies require a different provisioning mechanism", async () => {
  const f = await fixture()
  const manifest = await Bun.file(join(f.repo.path, "package.json")).json()
  manifest.dependencies["fixture-local"] = "file:packages/local"
  await Bun.write(join(f.repo.path, "package.json"), JSON.stringify(manifest))
  await commit(f.repo.path)
  await expect(
    OrynDependencies.seal({ source: f.repo.path, output: join(f.artifacts.path, "local"), abort: f.abort }),
  ).rejects.toMatchObject(unavailable)
})

test("dependency patch changes invalidate the sealed inputs", async () => {
  const f = await fixture()
  const manifest = await Bun.file(join(f.repo.path, "package.json")).json()
  manifest.patchedDependencies = { "fixture-math@1.0.0": "patches/math.patch" }
  await Bun.write(join(f.repo.path, "package.json"), JSON.stringify(manifest))
  await Bun.write(join(f.repo.path, "patches/math.patch"), "fixture patch content")
  await commit(f.repo.path)
  const sealed = await OrynDependencies.seal({
    source: f.repo.path,
    output: join(f.artifacts.path, "patched"),
    abort: f.abort,
  })
  f.profile.dependencySnapshots = [{ directory: sealed.directory, digest: sealed.digest }]
  await using experiment = await f.prepare()
  expect(experiment.dependencies).toBe(sealed.digest)
  await Bun.write(join(f.repo.path, "patches/math.patch"), "changed fixture patch content")
  await commit(f.repo.path)
  await expect(f.prepare()).rejects.toMatchObject(unavailable)
})
