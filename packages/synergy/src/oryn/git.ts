import { storeError } from "./store"

export namespace OrynGit {
  export type Change = { status: string; path: string }

  // PR scope follows GitHub's three-dot comparison, independently of target integration.
  // https://docs.github.com/en/pull-requests/committing-changes-to-your-project/viewing-and-comparing-commits/comparing-commits
  export async function versions(directory: string, targetBaseSha: string, headSha: string) {
    if (![targetBaseSha, headSha].every((sha) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)))
      throw storeError("INVALID_STAGE", "PR comparison requires full source versions")
    const bases = (await read(directory, ["merge-base", "--all", targetBaseSha, headSha])).split("\n")
    if (bases.length !== 1 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(bases[0]!))
      throw storeError("ENVIRONMENT_UNAVAILABLE", "PR comparison requires one verifiable common ancestor")
    return { headSha, targetBaseSha, mergeBaseSha: bases[0]! }
  }

  export async function changes(directory: string, baseline: string, candidate: string): Promise<Change[]> {
    if (![baseline, candidate].every((sha) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)))
      throw storeError("INVALID_STAGE", "publication requires full source versions")
    const raw = await OrynGit.read(directory, [
      "diff",
      "--name-status",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      baseline,
      candidate,
      "--",
    ])
    const fields = raw.split("\0")
    if (fields.at(-1) === "") fields.pop()
    if (fields.length % 2) throw storeError("INVALID_STAGE", "candidate change list is incomplete")
    const changes: Change[] = []
    for (let index = 0; index < fields.length; index += 2) {
      const status = fields[index]!
      const path = fields[index + 1]!
      if (!/^[AMDTUXB]$/.test(status) || !path || path.startsWith("/") || path.split("/").includes(".."))
        throw storeError("INVALID_STAGE", "candidate change list is invalid")
      changes.push({ status, path })
    }
    return changes
  }

  export function environment() {
    return {
      PATH: process.env.PATH ?? "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/dev/null",
      GIT_CONFIG_KEY_1: "core.fsmonitor",
      GIT_CONFIG_VALUE_1: "false",
    }
  }

  export async function read(directory: string, args: string[]): Promise<string> {
    if (args[0] === "status") {
      const modes = await read(directory, ["ls-files", "-z", "--format=%(objectmode)"])
      if (modes.split("\0").includes("160000"))
        throw storeError("ENVIRONMENT_UNAVAILABLE", "submodule inspection requires a contained environment")
      const keys = await read(directory, ["config", "--null", "--name-only", "--list"])
      if (keys.split("\0").some((key) => key.toLowerCase().startsWith("filter.")))
        throw storeError("ENVIRONMENT_UNAVAILABLE", "configured Git filters require a contained inspection environment")
    }
    const child = Bun.spawn(["git", "--no-optional-locks", ...args], {
      cwd: directory,
      env: environment(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 10_000,
      maxBuffer: 64 * 1024 * 1024,
      killSignal: "SIGKILL",
    })
    const [exit, output] = await Promise.all([child.exited, new Response(child.stdout).text()])
    if (exit !== 0) throw storeError("INVALID_STAGE", "assigned Git state could not be verified")
    return output.trim()
  }

  export async function snapshot(directory: string) {
    const [commits, status] = await Promise.all([
      read(directory, ["rev-parse", "--verify", "HEAD^{commit}"]),
      read(directory, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"]),
    ])
    const tree = await read(directory, ["rev-parse", "--verify", "HEAD^{tree}"])
    return { sha: commits, tree, dirty: status !== "" }
  }
}
