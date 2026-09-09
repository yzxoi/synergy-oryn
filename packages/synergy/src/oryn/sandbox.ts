import { existsSync } from "node:fs"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, sep } from "node:path"
import type { OrynExecutionProfile } from "../config/schema"
import { SandboxBackend } from "../sandbox/backend"
import { storeError } from "./store"
import { OrynGit } from "./git"
import { OrynResources } from "./resources"

export const SYSTEM_READ_ROOTS = [
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/usr/lib",
  "/usr/lib64",
  "/usr/share",
  "/lib",
  "/lib64",
  "/System/Library",
  "/Library/Developer/CommandLineTools",
  "/opt/homebrew/bin",
  "/opt/homebrew/Cellar",
  "/opt/homebrew/opt",
  "/opt/homebrew/lib",
  "/usr/local/bin",
  "/usr/local/lib",
]

export namespace OrynSandbox {
  export async function execute(input: {
    argv: string[]
    cwd: string
    timeoutMs: number
    abort: AbortSignal
    profile: OrynExecutionProfile
    writableRoots?: string[]
    readableRoots?: string[]
    downloadCache?: string
  }) {
    input.abort.throwIfAborted()
    const trusted = input.profile.isolation === "trusted_local"
    if (input.profile.isolation && input.profile.isolation !== "sandbox" && !trusted)
      throw storeError(
        "ENVIRONMENT_UNAVAILABLE",
        "checks require OS sandbox isolation; external VM execution is not configured",
      )
    const supported = [
      ...(trusted ? ["network_egress"] : process.platform === "linux" ? ["namespace", "seccomp"] : []),
      ...(process.platform === "linux" && input.profile.resourceLimits ? ["cgroup"] : []),
    ]
    if (input.profile.requiredCapabilities?.some((capability) => !supported.includes(capability)))
      throw storeError(
        "ENVIRONMENT_UNAVAILABLE",
        "check profile requires capabilities unavailable to the local sandbox",
      )
    if (!input.profile.commandAllowlist.includes(input.argv[0]))
      throw storeError("ENVIRONMENT_UNAVAILABLE", "check executable is not approved by the installation profile")
    const searchPath = (process.env.PATH ?? "").split(":").filter(isAbsolute).join(":")
    const command = Bun.which(input.argv[0], { PATH: searchPath, cwd: input.cwd })
    if (!command) throw storeError("ENVIRONMENT_UNAVAILABLE", "check executable is unavailable")
    const scratch = await realpath(await mkdtemp(join(tmpdir(), "oryn-check-")))
    try {
      const workspace = await realpath(input.cwd)
      const writableRoots = await Promise.all((input.writableRoots ?? []).map((root) => realpath(root)))
      for (const root of writableRoots) {
        const path = relative(workspace, root)
        if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
          throw storeError("NOT_AUTHORIZED", "check output directory is outside the experiment")
      }
      const wrapper = trusted
        ? { command: await realpath(command), args: input.argv.slice(1), sandboxed: false }
        : SandboxBackend.prepareWrapper({
            command: process.platform === "linux" ? "/bin/sh" : await realpath(command),
            args:
              process.platform === "linux"
                ? [
                    "-c",
                    'cd "$1" && shift && exec "$@"',
                    "oryn-check",
                    workspace,
                    await realpath(command),
                    ...input.argv.slice(1),
                  ]
                : input.argv.slice(1),
            workspace,
            executionCwd: scratch,
            sandboxMode: "read_only",
            permissionProfile: {
              fileSystem: {
                workspace,
                readableRoots: [
                  workspace,
                  await realpath(command),
                  ...SYSTEM_READ_ROOTS.filter(existsSync),
                  ...(input.readableRoots ?? []),
                ],
                writableRoots: [scratch, ...writableRoots],
                readOnlySubpaths: [],
                unreadableGlobs: [],
                protectedMetadataNames: [".git", ".agents", ".codex", ".synergy"],
                protectedPaths: [],
                dataDenyRoots: [],
                includePlatformDefaults: false,
              },
              network: { mode: "restricted", allowLocalBinding: false, allowedUnixSockets: [] },
            },
          })
      if ((!trusted && !wrapper.sandboxed) || wrapper.skipReason) {
        if (wrapper.tempPath) SandboxBackend.cleanupTemp(wrapper.tempPath)
        throw storeError("ENVIRONMENT_UNAVAILABLE", wrapper.skipReason ?? "OS sandbox is unavailable")
      }
      const resources = await OrynResources.prepare({
        wrapper,
        cwd: workspace,
        limits: input.profile.resourceLimits,
        abort: input.abort,
        environment: {
          ...OrynGit.environment(),
          GIT_OPTIONAL_LOCKS: "0",
          HOME: scratch,
          TMPDIR: scratch,
          TMP: scratch,
          TEMP: scratch,
          PATH: searchPath,
          LANG: "C.UTF-8",
          BUN_CONFIG_NO_AUTO_INSTALL: "true",
          ...(trusted && input.downloadCache
            ? { BUN_INSTALL_CACHE_DIR: input.downloadCache, npm_config_cache: input.downloadCache }
            : {}),
        },
      }).catch((error) => {
        if (wrapper.tempPath) SandboxBackend.cleanupTemp(wrapper.tempPath)
        throw error
      })
      try {
        const result = await SandboxBackend.executeAsync(resources.wrapper, {
          cwd: workspace,
          env: resources.environment,
          inheritEnv: false,
          networkMode: trusted ? "full" : "restricted",
          fallbackPolicy: "deny",
          signal: input.abort,
          timeoutMs: input.timeoutMs,
          maxOutputBytes: 64 * 1024,
        })
        await resources.verify()
        return result
      } finally {
        await resources.dispose()
      }
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }
}
