import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, readdir, readlink, realpath, rename, rm, symlink } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { z } from "zod"
import type { OrynExecutionProfile } from "../config/schema"
import { OrynGit } from "./git"
import { OrynStoreError, storeError } from "./store"

const MAX_FILE_BYTES = 512 * 1024 * 1024
const MAX_TOTAL_BYTES = 64 * 1024 * 1024 * 1024
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024
const MAX_ENTRIES = 250_000
const Digest = z.string().regex(/^[a-f0-9]{64}$/)
const Entry = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("file"),
      path: z.string(),
      digest: Digest,
      bytes: z.number().int().min(0).max(MAX_FILE_BYTES),
      executable: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal("symlink"), path: z.string(), target: z.string() }).strict(),
])
const Manifest = z
  .object({
    schemaVersion: z.literal(1),
    platform: z.string(),
    arch: z.string(),
    bunVersion: z.string(),
    inputs: z
      .array(z.object({ path: z.string(), object: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/) }).strict())
      .max(10000),
    roots: z.array(z.string()).min(1).max(256),
    entries: z.array(Entry).max(MAX_ENTRIES),
  })
  .strict()
type Manifest = z.infer<typeof Manifest>

function unavailable(message: string) {
  return storeError("ENVIRONMENT_UNAVAILABLE", message)
}

function validPath(path: string) {
  return (
    !isAbsolute(path) &&
    !/[\\\x00-\x1f\x7f]/.test(path) &&
    path.length <= 4096 &&
    path
      .split("/")
      .every((part) => part && ![".", "..", ".git", ".agents", ".codex", ".synergy"].includes(part.toLowerCase()))
  )
}

function inside(path: string, root: string) {
  const part = relative(root, path)
  return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

function linkTarget(path: string, target: string) {
  if (!target || isAbsolute(target) || /[\\\x00-\x1f\x7f]/.test(target))
    throw unavailable("Dependency link must be relative to its repository")
  const result = relative("/oryn-project", resolve("/oryn-project", dirname(path), target))
  if (!validPath(result)) throw unavailable("Dependency link escapes the experiment or targets protected metadata")
}

async function batches<T>(values: T[], run: (value: T) => Promise<void>) {
  for (let index = 0; index < values.length; index += 16) {
    const results = await Promise.allSettled(values.slice(index, index + 16).map(run))
    const failed = results.find((item) => item.status === "rejected")
    if (failed?.status === "rejected") throw failed.reason
  }
}

async function copy(source: string, destination: string, abort: AbortSignal) {
  abort.throwIfAborted()
  const reader = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await reader.stat()
    if (!info.isFile() || info.size > MAX_FILE_BYTES)
      throw unavailable("Dependency blob is not a bounded ordinary file")
    const writer = await open(destination, "wx", 0o644)
    try {
      const hash = new Bun.CryptoHasher("sha256")
      let bytes = 0
      for await (const chunk of reader.createReadStream({ autoClose: false, highWaterMark: 512 * 1024 })) {
        abort.throwIfAborted()
        bytes += chunk.length
        if (bytes > MAX_FILE_BYTES) throw unavailable("Dependency blob exceeded its size limit")
        hash.update(chunk)
        await writer.writeFile(chunk)
      }
      return { digest: hash.digest("hex"), bytes }
    } finally {
      await writer.close()
    }
  } finally {
    await reader.close()
  }
}

async function inputs(directory: string) {
  const raw = await OrynGit.read(directory, ["ls-tree", "-rz", "--full-tree", "HEAD"])
  const tree = new Map<string, string>()
  const regular = new Set<string>()
  for (const value of raw.split("\0").filter(Boolean)) {
    const match = /^([0-9]{6}) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(value)
    if (match) {
      tree.set(match[3], match[2])
      if (["100644", "100755"].includes(match[1])) regular.add(match[3])
    }
  }
  if (!tree.has("package.json") || (!tree.has("bun.lock") && !tree.has("bun.lockb")))
    throw unavailable("Dependency snapshots require a tracked Bun lockfile and root package manifest")
  const names = new Set([
    "package.json",
    "bun.lock",
    "bun.lockb",
    "bunfig.toml",
    ".npmrc",
    ".yarnrc.yml",
    "pnpm-workspace.yaml",
  ])
  const selected = new Set([...tree.keys()].filter((path) => names.has(basename(path))))
  const packageInfo = JSON.parse(await OrynGit.read(directory, ["show", "HEAD:package.json"])) as {
    patchedDependencies?: Record<string, unknown>
    workspaces?: string[]
  }
  if (
    packageInfo.workspaces &&
    (!Array.isArray(packageInfo.workspaces) || packageInfo.workspaces.some((value) => typeof value !== "string"))
  )
    throw unavailable("Unsupported workspace declaration")
  const workspaces = (packageInfo.workspaces ?? []).map((pattern) => new Bun.Glob(pattern))
  const manifests = [...selected].filter(
    (path) =>
      basename(path) === "package.json" &&
      (path === "package.json" || workspaces.some((glob) => glob.match(dirname(path)))),
  )
  await batches(manifests, async (path) => {
    const info = JSON.parse(await OrynGit.read(directory, ["show", `HEAD:${path}`])) as Record<
      string,
      Record<string, unknown>
    >
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "overrides", "resolutions"]) {
      for (const value of Object.values(info[field] ?? {})) {
        if (typeof value !== "string" || /^(?:file:|link:|\.{1,2}\/|\/|~\/)/.test(value))
          throw unavailable(
            "Snapshots require registry, Git or workspace dependencies; local copied dependencies are unsupported",
          )
      }
    }
  })
  for (const patch of Object.values(packageInfo.patchedDependencies ?? {})) {
    if (typeof patch !== "string") throw unavailable("Unsupported dependency patch declaration")
    const path = patch.replace(/^\.\//, "")
    if (!validPath(path) || !tree.has(path)) throw unavailable("Dependency patch is not a tracked repository file")
    selected.add(path)
  }
  if ([...selected].some((path) => !regular.has(path)))
    throw unavailable("Dependency inputs must be ordinary tracked files")
  return [...selected].sort().map((path) => ({ path, object: tree.get(path)! }))
}

function validate(manifest: Manifest) {
  const paths = new Set<string>()
  let bytes = 0
  for (const root of manifest.roots) {
    if (!validPath(root) || basename(root) !== "node_modules")
      throw unavailable("Snapshot roots must be repository dependency directories")
  }
  for (const entry of manifest.entries) {
    if (
      !validPath(entry.path) ||
      paths.has(entry.path) ||
      !manifest.roots.some((root) => entry.path.startsWith(root + "/"))
    )
      throw unavailable("Invalid or duplicate dependency entry")
    paths.add(entry.path)
    if (entry.kind === "symlink") linkTarget(entry.path, entry.target)
    else bytes += entry.bytes
  }
  if (bytes > MAX_TOTAL_BYTES) throw unavailable("Dependency snapshot exceeds the total size limit")
  for (const path of paths) {
    let parent = dirname(path)
    while (parent !== ".") {
      if (paths.has(parent)) throw unavailable("Dependency entries cannot contain files or links as ancestors")
      parent = dirname(parent)
    }
  }
}

async function readManifest(snapshot: { directory: string; digest: string }) {
  const directory = await realpath(snapshot.directory)
  const blobs = await lstat(join(directory, "blobs"))
  if (!blobs.isDirectory() || blobs.isSymbolicLink())
    throw unavailable("Dependency blobs require an ordinary directory")
  const file = await open(join(directory, "manifest.json"), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) throw unavailable("Invalid dependency manifest size")
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      bytes += chunk.length
      if (bytes > MAX_MANIFEST_BYTES) throw unavailable("Dependency manifest exceeded its size limit")
      chunks.push(chunk)
    }
    const content = Buffer.concat(chunks)
    if (new Bun.CryptoHasher("sha256").update(content).digest("hex") !== snapshot.digest)
      throw unavailable("Dependency manifest digest does not match installation policy")
    const manifest = Manifest.parse(JSON.parse(content.toString("utf8")))
    validate(manifest)
    return { directory, manifest, digest: snapshot.digest }
  } finally {
    await file.close()
  }
}

export namespace OrynDependencies {
  export async function seal(input: { source: string; output: string; abort: AbortSignal }) {
    input.abort.throwIfAborted()
    const source = await realpath(input.source)
    if (!["darwin", "linux"].includes(process.platform)) throw unavailable("Dependency snapshots require a POSIX Host")
    if (source !== (await realpath(await OrynGit.read(source, ["rev-parse", "--show-toplevel"]))))
      throw unavailable("Seal dependencies from the repository root")
    const output = join(await realpath(dirname(resolve(input.output))), basename(resolve(input.output)))
    if (inside(output, source) || inside(source, output))
      throw unavailable("Snapshot output must be outside the source checkout")
    const before = await OrynGit.snapshot(source)
    if (before.dirty) throw unavailable("Seal dependencies from a clean reviewed checkout")
    const dependencyInputs = await inputs(source)
    const roots: string[] = []
    for (const item of dependencyInputs.filter((item) => basename(item.path) === "package.json")) {
      const root = join(dirname(item.path), "node_modules")
      const info = await lstat(join(source, root)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (!info) continue
      if (!info.isDirectory() || info.isSymbolicLink())
        throw unavailable("Installed dependency roots must be ordinary directories")
      if (await OrynGit.read(source, ["ls-files", "-z", "--", `:(literal,icase)${root}`]))
        throw unavailable("Snapshot dependencies must not overlap tracked source")
      roots.push(root)
    }
    if (!roots.length) throw unavailable("No installed dependency directories were found")
    await mkdir(output)
    try {
      await mkdir(join(output, "blobs"))
      const entries: Manifest["entries"] = []
      async function walk(path: string) {
        input.abort.throwIfAborted()
        for (const name of (await readdir(join(source, path))).sort()) {
          const child = join(path, name)
          if (!validPath(child)) throw unavailable("Dependency tree contains protected metadata or unsupported paths")
          const info = await lstat(join(source, child))
          if (info.isDirectory()) await walk(child)
          else if (info.isSymbolicLink()) {
            const target = relative(
              dirname(join(source, child)),
              resolve(dirname(join(source, child)), await readlink(join(source, child))),
            )
            linkTarget(child, target)
            entries.push({ kind: "symlink", path: child, target })
          } else if (info.isFile())
            entries.push({
              kind: "file",
              path: child,
              digest: "",
              bytes: info.size,
              executable: (info.mode & 0o111) !== 0,
            })
          else throw unavailable("Dependency tree contains a special file")
          if (entries.length > MAX_ENTRIES) throw unavailable("Dependency snapshot has too many entries")
        }
      }
      for (const root of roots) await walk(root)
      let bytes = 0
      for (const entry of entries) if (entry.kind === "file") bytes += entry.bytes
      if (bytes > MAX_TOTAL_BYTES) throw unavailable("Dependency snapshot exceeds the total size limit")
      await batches(entries, async (entry) => {
        if (entry.kind !== "file") return
        const temporary = join(output, "blobs", `.${crypto.randomUUID()}`)
        const content = await copy(join(source, entry.path), temporary, input.abort)
        if (content.bytes !== entry.bytes) throw unavailable("Installed dependency changed while sealing")
        entry.digest = content.digest
        await rename(temporary, join(output, "blobs", content.digest))
      })
      entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      const manifest = Manifest.parse({
        schemaVersion: 1,
        platform: process.platform,
        arch: process.arch,
        bunVersion: Bun.version,
        inputs: dependencyInputs,
        roots: roots.sort(),
        entries,
      })
      validate(manifest)
      const after = await OrynGit.snapshot(source)
      if (after.dirty || before.sha !== after.sha) throw unavailable("Source changed while sealing dependencies")
      const content = JSON.stringify(manifest)
      if (Buffer.byteLength(content) > MAX_MANIFEST_BYTES)
        throw unavailable("Dependency manifest exceeded its size limit")
      input.abort.throwIfAborted()
      await Bun.write(join(output, "manifest.json"), content)
      input.abort.throwIfAborted()
      return {
        directory: output,
        digest: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
        files: entries.length,
        bytes,
      }
    } catch (error) {
      await rm(output, { recursive: true, force: true })
      throw error
    }
  }

  export async function install(input: {
    directory: string
    snapshots: OrynExecutionProfile["dependencySnapshots"]
    abort: AbortSignal
  }) {
    if (!input.snapshots?.length) return undefined
    try {
      const expected = JSON.stringify(await inputs(input.directory))
      const matches: Awaited<ReturnType<typeof readManifest>>[] = []
      for (const snapshot of input.snapshots) {
        input.abort.throwIfAborted()
        const current = await readManifest(snapshot)
        if (
          current.manifest.platform === process.platform &&
          current.manifest.arch === process.arch &&
          current.manifest.bunVersion === Bun.version &&
          JSON.stringify(current.manifest.inputs) === expected
        )
          matches.push(current)
      }
      if (matches.length !== 1)
        throw unavailable("Exactly one dependency snapshot must match source inputs and Host runtime")
      const selected = matches[0]
      for (const root of selected.manifest.roots) {
        if (await OrynGit.read(input.directory, ["ls-files", "-z", "--", `:(literal,icase)${root}`]))
          throw unavailable("Dependency snapshot overlaps tracked source")
        let parent = input.directory
        for (const part of root.split("/")) {
          parent = join(parent, part)
          const info = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined
            throw error
          })
          if (info && (!info.isDirectory() || info.isSymbolicLink() || parent === join(input.directory, root)))
            throw unavailable("Dependency roots require unoccupied ordinary source paths")
          if (!info) await mkdir(parent)
        }
      }
      for (const entry of selected.manifest.entries)
        await mkdir(dirname(join(input.directory, entry.path)), { recursive: true })
      await batches(selected.manifest.entries, async (entry) => {
        if (entry.kind !== "file") return
        const destination = join(input.directory, entry.path)
        const actual = await copy(join(selected.directory, "blobs", entry.digest), destination, input.abort)
        if (actual.digest !== entry.digest || actual.bytes !== entry.bytes)
          throw unavailable("Dependency blob failed content verification")
        await chmod(destination, entry.executable ? 0o755 : 0o644)
      })
      for (const entry of selected.manifest.entries)
        if (entry.kind === "symlink") await symlink(entry.target, join(input.directory, entry.path))
      for (const entry of selected.manifest.entries) {
        input.abort.throwIfAborted()
        if (entry.kind !== "symlink") continue
        const target = relative(input.directory, await realpath(join(input.directory, entry.path)))
        if (!validPath(target))
          throw unavailable("Dependency link resolves outside the experiment or into protected metadata")
      }
      return selected.digest
    } catch (error) {
      input.abort.throwIfAborted()
      if (error instanceof OrynStoreError) throw error
      throw unavailable("Dependency snapshot could not be verified or materialized")
    }
  }
}
