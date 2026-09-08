import { realpath } from "node:fs/promises"
import { OrynGit } from "./git"
import { Session } from "../session"
import type { Assignment, Attempt } from "./schema"
import { OrynStoreError, storeError } from "./store"

export namespace OrynCandidate {
  export async function workspace(assignment: Assignment, localBranch?: string) {
    if (assignment.stage !== "code" || assignment.agentId !== "oryn-code" || !assignment.sessionId)
      throw storeError("NOT_AUTHORIZED", "candidate requires the assigned code worker")
    const session = await Session.get(assignment.sessionId)
    const workspace = session.workspace
    if (session.agentOverride !== "oryn-code" || workspace?.type !== "git_worktree" || !assignment.workspaceRef)
      throw storeError("NOT_AUTHORIZED", "candidate requires the assigned worktree")
    const directory = await realpath(workspace.path)
    if ((await realpath(assignment.workspaceRef)) !== directory)
      throw storeError("NOT_AUTHORIZED", "candidate workspace binding changed")
    const root = await realpath(await OrynGit.read(directory, ["rev-parse", "--show-toplevel"]))
    if (root !== directory) throw storeError("NOT_AUTHORIZED", "candidate directory is not a worktree root")
    const common = await realpath(
      await OrynGit.read(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    )
    const expected = await realpath(
      await OrynGit.read(session.scope.directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    )
    if (common !== expected) throw storeError("NOT_AUTHORIZED", "candidate belongs to a different repository")
    const branch = await OrynGit.read(directory, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    if (branch !== workspace.branch || (localBranch !== undefined && localBranch !== branch))
      throw storeError("INVALID_STAGE", "candidate branch differs from the assigned branch")
    return { directory, branch }
  }

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
    try {
      const { directory } = await workspace(assignment, input.localBranch)
      if ((await OrynGit.read(directory, ["rev-parse", "--verify", "HEAD^{commit}"])) !== candidateSha)
        throw storeError("INVALID_STAGE", "candidate is not the assigned branch HEAD")
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(attempt.baselineSha))
        throw storeError("INVALID_STAGE", "candidate baseline is not a full commit SHA")
      await OrynGit.read(directory, ["merge-base", "--is-ancestor", attempt.baselineSha, candidateSha])
      if (
        await OrynGit.read(directory, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--ignore-submodules=all",
        ])
      )
        throw storeError("INVALID_STAGE", "candidate contains uncommitted changes")
      if ((await OrynGit.read(directory, ["rev-parse", "--verify", "HEAD^{commit}"])) !== candidateSha)
        throw storeError("INVALID_STAGE", "candidate changed during verification")
    } catch (error) {
      if (error instanceof OrynStoreError) throw error
      throw storeError("INVALID_STAGE", "candidate workspace is unavailable for verification")
    }
  }
}
