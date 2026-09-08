import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, sep } from "node:path"
import type { OrynExecutionProfile } from "../config/schema"
import { OrynGit } from "./git"
import { storeError } from "./store"
import { OrynDependencies } from "./dependencies"

export namespace OrynExperiment {
  export async function prepare(input: {
    source: string
    sha: string
    profile: OrynExecutionProfile
    abort: AbortSignal
  }) {
    input.abort.throwIfAborted()
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.sha))
      throw storeError("INVALID_STAGE", "experiment requires a fixed source commit")
    const common = await realpath(
      await OrynGit.read(input.source, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    )
    const objects = await realpath(join(common, "objects"))
    const objectPath = relative(common, objects)
    if (objectPath === ".." || objectPath.startsWith(`..${sep}`) || isAbsolute(objectPath))
      throw storeError("ENVIRONMENT_UNAVAILABLE", "experiment object store is outside the approved repository")
    const format = await OrynGit.read(input.source, ["rev-parse", "--show-object-format"])
    if (!["sha1", "sha256"].includes(format))
      throw storeError("ENVIRONMENT_UNAVAILABLE", "experiment requires a supported Git object format")
    const root = await realpath(await mkdtemp(join(tmpdir(), "oryn-experiment-")))
    const dispose = () => rm(root, { recursive: true, force: true })
    try {
      const directory = join(root, "source")
      await mkdir(directory)
      await OrynGit.read(directory, ["init", "--template=", `--object-format=${format}`, "."])
      await Promise.all([
        Bun.write(join(directory, ".git", "objects", "info", "alternates"), `${JSON.stringify(objects)}\n`),
        Bun.write(join(directory, ".git", "HEAD"), `${input.sha}\n`),
      ])
      await OrynGit.read(directory, ["config", "core.attributesFile", "/dev/null"])
      await OrynGit.read(directory, ["read-tree", input.sha])
      const modes = await OrynGit.read(directory, ["ls-files", "-z", "--format=%(objectmode)"])
      if (modes.split("\0").includes("160000"))
        throw storeError("ENVIRONMENT_UNAVAILABLE", "experiment dependencies must not require submodule checkout")
      input.abort.throwIfAborted()
      await OrynGit.read(directory, ["checkout-index", "--all"])
      const dependencies = await OrynDependencies.install({
        directory,
        snapshots: input.profile.dependencySnapshots,
        abort: input.abort,
      })
      const writableRoots: string[] = []
      const created = new Set<string>()
      for (const path of input.profile.writableDirectories ?? []) {
        const parts = path.split("/")
        if (
          isAbsolute(path) ||
          path.includes("\\") ||
          /[\x00-\x1f\x7f]/.test(path) ||
          parts.some(
            (part) => !part || [".", "..", ".git", ".agents", ".codex", ".synergy"].includes(part.toLowerCase()),
          )
        )
          throw storeError("ENVIRONMENT_UNAVAILABLE", "invalid experiment output directory")
        if (await OrynGit.read(directory, ["ls-files", "-z", "--", `:(literal,icase)${path}`]))
          throw storeError("ENVIRONMENT_UNAVAILABLE", "experiment output directory overlaps tracked source")
        const target = join(directory, path)
        let parent = directory
        for (const part of parts) {
          parent = join(parent, part)
          const info = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined
            throw error
          })
          if (info && (!info.isDirectory() || info.isSymbolicLink()))
            throw storeError("ENVIRONMENT_UNAVAILABLE", "experiment output requires ordinary directory ancestors")
          if (info && parent === target && !created.has(await realpath(parent)))
            throw storeError("ENVIRONMENT_UNAVAILABLE", "experiment output directory overlaps materialized source")
          if (!info) {
            await mkdir(parent)
            created.add(await realpath(parent))
          }
        }
        writableRoots.push(parent)
      }
      input.abort.throwIfAborted()
      return {
        directory,
        dependencies,
        readableRoots: [objects],
        writableRoots,
        async changed() {
          try {
            await OrynGit.read(directory, ["diff", "--quiet", "--no-ext-diff", "--no-textconv", input.sha, "--"])
            return (await OrynGit.read(directory, ["rev-parse", "HEAD"])) !== input.sha
          } catch {
            return true
          }
        },
        [Symbol.asyncDispose]: dispose,
      }
    } catch (error) {
      await dispose()
      throw error
    }
  }
}
