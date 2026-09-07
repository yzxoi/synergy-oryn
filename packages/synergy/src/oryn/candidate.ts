import { realpath } from "node:fs/promises"
import { Session } from "../session"
import type { Assignment, Attempt } from "./schema"
import { OrynStoreError, storeError } from "./store"

async function git(directory: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "--no-optional-locks", ...args], {
    cwd: directory,
    env: {
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
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    killSignal: "SIGKILL",
  })
  const [exit, output] = await Promise.all([child.exited, new Response(child.stdout).text()])
  if (exit !== 0) throw storeError("INVALID_STAGE", "candidate Git state could not be verified")
  return output.trim()
}

export namespace OrynCandidate {
  export async function verify(input: {
    assignment: Assignment
    attempt: Attempt
    candidateSha?: string
    localBranch?: string
  }): Promise<void> {
    const { assignment, attempt, candidateSha } = input
    if (!candidateSha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(candidateSha))
      throw storeError("INVALID_STAGE", "candidate requires a full commit SHA")
    if (attempt.candidateSha && attempt.candidateSha !== candidateSha)
      throw storeError("INVALID_STAGE", "a frozen candidate requires a new Attempt before changes")
    if (assignment.stage !== "code" || assignment.agentId !== "oryn-code" || !assignment.sessionId)
      throw storeError("NOT_AUTHORIZED", "candidate requires the assigned code worker")
    const session = await Session.get(assignment.sessionId)
    const workspace = session.workspace
    if (session.agentOverride !== "oryn-code" || workspace?.type !== "git_worktree" || !assignment.workspaceRef)
      throw storeError("NOT_AUTHORIZED", "candidate requires the assigned worktree")
    try {
      const directory = await realpath(workspace.path)
      if ((await realpath(assignment.workspaceRef)) !== directory)
        throw storeError("NOT_AUTHORIZED", "candidate workspace binding changed")
      const root = await realpath(await git(directory, ["rev-parse", "--show-toplevel"]))
      if (root !== directory) throw storeError("NOT_AUTHORIZED", "candidate directory is not a worktree root")
      const common = await realpath(await git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
      const expected = await realpath(
        await git(session.scope.directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      )
      if (common !== expected) throw storeError("NOT_AUTHORIZED", "candidate belongs to a different repository")
      const branch = await git(directory, ["symbolic-ref", "--quiet", "--short", "HEAD"])
      if (branch !== workspace.branch || (input.localBranch !== undefined && input.localBranch !== branch))
        throw storeError("INVALID_STAGE", "candidate branch differs from the assigned branch")
      if ((await git(directory, ["rev-parse", "--verify", "HEAD^{commit}"])) !== candidateSha)
        throw storeError("INVALID_STAGE", "candidate is not the assigned branch HEAD")
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(attempt.baselineSha))
        throw storeError("INVALID_STAGE", "candidate baseline is not a full commit SHA")
      await git(directory, ["merge-base", "--is-ancestor", attempt.baselineSha, candidateSha])
      if (await git(directory, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]))
        throw storeError("INVALID_STAGE", "candidate contains uncommitted changes")
      if ((await git(directory, ["rev-parse", "--verify", "HEAD^{commit}"])) !== candidateSha)
        throw storeError("INVALID_STAGE", "candidate changed during verification")
    } catch (error) {
      if (error instanceof OrynStoreError) throw error
      throw storeError("INVALID_STAGE", "candidate workspace is unavailable for verification")
    }
  }
}
