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
    patch?: string
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
      const dependencies = await OrynDependencies.prepare({
        directory,
        profile: input.profile,
        abort: input.abort,
      })
      if (input.patch) {
        if (Buffer.byteLength(input.patch) > 256 * 1024)
          throw storeError("INVALID_STAGE", "Verification patch exceeds 256 KiB")
        const patchFile = join(directory, ".git", "oryn-verification.patch")
        await Bun.write(patchFile, input.patch)
        const stat = await OrynGit.read(directory, ["apply", "--numstat", "-z", patchFile])
        const files = stat
          .split("\0")
          .filter(Boolean)
          .map((line) => line.match(/^\d+\t\d+\t([^]+)$/)?.[1])
        if (
          !files.length ||
          files.some(
            (file) =>
              !file ||
              !/(^|\/)(test|tests|__tests__|e2e)\//.test(file) ||
              file.split("/").some((part) => ["..", ".git", ".synergy", ".agents", ".codex"].includes(part)) ||
              isAbsolute(file),
          )
        )
          throw storeError(
            "NOT_AUTHORIZED",
            "Verification overlays may change only ordinary files under test directories",
          )
        await OrynGit.read(directory, ["apply", "--index", "--whitespace=nowarn", patchFile])
        for (const file of files) {
          const mode = await OrynGit.read(directory, ["ls-files", "--format=%(objectmode)", "--", file!])
          if (mode && !["100644", "100755"].includes(mode))
            throw storeError("NOT_AUTHORIZED", "Verification patches cannot add links or submodules")
        }
        await rm(patchFile)
      }
      const treeDigest = await OrynGit.read(directory, ["write-tree"])
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
        treeDigest,
        readableRoots: [objects],
        writableRoots,
        async changed() {
          try {
            await OrynGit.read(directory, ["diff", "--quiet", "--no-ext-diff", "--no-textconv", "--"])
            return (
              (await OrynGit.read(directory, ["rev-parse", "HEAD"])) !== input.sha ||
              (await OrynGit.read(directory, ["write-tree"])) !== treeDigest
            )
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
