import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { Global } from "../global"
import { Lock } from "../util/lock"
import { externalIdentityHash } from "../util/identity"
import { OrynCandidate } from "./candidate"
import { OrynConfig } from "./config"
import { OrynGit } from "./git"
import { OrynPublicText } from "./public-text"
import { OrynStore, storeError } from "./store"

export namespace OrynCandidateCommit {
  export async function create(input: {
    callerSessionID: string
    caseId: string
    attemptId: string
    assignmentId: string
    requestKey: string
    title: string
    paths: string[]
    abort: AbortSignal
  }) {
    input.abort.throwIfAborted()
    using lock = await Lock.write(`oryn-case:${input.caseId}`)
    const binding = await OrynStore.sessionSourceBinding(input.callerSessionID)
    const record = await OrynStore.getCase(input.caseId)
    const attempt = await OrynStore.getAttempt(input.caseId, input.attemptId)
    const assignment = await OrynStore.getAssignment(input.caseId, input.assignmentId)
    if (
      !(await OrynConfig.enabled()) ||
      binding?.role !== "worker" ||
      binding.caseId !== input.caseId ||
      !record ||
      record.control !== "active" ||
      record.activeAttemptId !== input.attemptId ||
      !attempt ||
      attempt.candidateSha ||
      ["superseded", "failed", "handed_off", "ready"].includes(attempt.disposition) ||
      !assignment ||
      assignment.attemptId !== input.attemptId ||
      assignment.epoch !== record.epoch ||
      assignment.sessionId !== input.callerSessionID ||
      assignment.acceptedReportId
    )
      throw storeError("NOT_AUTHORIZED", "commit requires the active unfrozen code assignment")
    if (
      !/^(fix|feat|refactor|test|docs|perf|build|ci|chore)(\([^\r\n()]+\))?!?: [^\r\n]+$/.test(input.title) ||
      input.title.length > 200
    )
      throw storeError("INVALID_STAGE", "commit title must be a single conventional title of at most 200 characters")
    if (!input.requestKey || input.requestKey.length > 200 || OrynPublicText.violations(input.title).length)
      throw storeError("NOT_AUTHORIZED", "commit request identity or public title is invalid")
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(attempt.baselineSha))
      throw storeError("INVALID_STAGE", "commit requires a full baseline SHA")
    const paths = [...new Set(input.paths)].sort()
    if (
      !paths.length ||
      paths.length > 128 ||
      paths.some(
        (value) =>
          !value ||
          value.length > 1024 ||
          /[\\\x00-\x1f]/.test(value) ||
          path.posix.isAbsolute(value) ||
          /^[a-z]:/i.test(value) ||
          value
            .split("/")
            .some(
              (part, index, parts) =>
                !part ||
                [".", "..", ".git", ".agents", ".codex"].includes(part.toLowerCase()) ||
                (part.toLowerCase() === ".synergy" && parts[index + 1] !== "skill"),
            ),
      )
    )
      throw storeError(
        "NOT_AUTHORIZED",
        "commit paths must be explicit relative source paths without protected metadata",
      )
    const { directory, branch } = await OrynCandidate.workspace(assignment)
    for (const value of paths) {
      const target = await lstat(path.join(directory, value)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (target?.isDirectory()) throw storeError("NOT_AUTHORIZED", "commit paths must name individual files")
      let parent = path.dirname(path.join(directory, value))
      while (parent !== directory) {
        const stat = await lstat(parent)
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw storeError("NOT_AUTHORIZED", "commit path crosses a non-directory or symlink")
        parent = path.dirname(parent)
      }
    }
    const before = await OrynGit.snapshot(directory)
    const identity = externalIdentityHash(
      input.caseId,
      input.attemptId,
      input.assignmentId,
      input.requestKey,
      input.title,
      JSON.stringify(paths),
    )
    const message = `${input.title}\n\nCo-authored-by: synergy-agent <299070056+synergy-agent@users.noreply.github.com>\nOryn-Commit: ${identity}`
    const replay = before.sha !== attempt.baselineSha
    if (
      replay &&
      ((await OrynGit.read(directory, ["show", "-s", "--format=%B", before.sha])) !== message ||
        (await OrynGit.read(directory, ["rev-parse", `${before.sha}^`])) !== attempt.baselineSha)
    )
      throw storeError("INVALID_STAGE", "assigned branch changed; only the same Host commit request may resume")
    await mkdir(Global.Path.cache, { recursive: true })
    const scratch = await mkdtemp(path.join(Global.Path.cache, "oryn-index-"))
    const index = path.join(scratch, "index")
    const run = async (args: string[], text?: string, privateIndex = true) => {
      input.abort.throwIfAborted()
      const child = Bun.spawn(["git", "--literal-pathspecs", ...args], {
        cwd: directory,
        env: {
          ...OrynGit.environment(),
          ...(privateIndex ? { GIT_INDEX_FILE: index } : {}),
          GIT_AUTHOR_NAME: "synergy-agent",
          GIT_AUTHOR_EMAIL: "299070056+synergy-agent@users.noreply.github.com",
          GIT_COMMITTER_NAME: "synergy-agent",
          GIT_COMMITTER_EMAIL: "299070056+synergy-agent@users.noreply.github.com",
        },
        stdin: text === undefined ? "ignore" : new Blob([text]),
        stdout: "pipe",
        stderr: "ignore",
        timeout: 10000,
        signal: input.abort,
        killSignal: "SIGKILL",
      })
      const reader = child.stdout.getReader()
      const chunks: Uint8Array[] = []
      let bytes = 0
      try {
        while (true) {
          const item = await reader.read()
          if (item.done) break
          bytes += item.value.byteLength
          if (bytes > 65536) {
            child.kill("SIGKILL")
            throw storeError("INVALID_STAGE", "Git operation exceeded its output bound")
          }
          chunks.push(item.value)
        }
        if ((await child.exited) !== 0)
          throw storeError(
            "INVALID_STAGE",
            "candidate commit operation failed; inspect the assigned source before retrying",
          )
        return Buffer.concat(chunks).toString("utf8").trim()
      } finally {
        reader.releaseLock()
        if (child.exitCode === null) child.kill("SIGKILL")
        await child.exited
      }
    }
    try {
      await run(["read-tree", attempt.baselineSha])
      await run(["add", "--", ...paths])
      if (
        (await run(["diff", "--name-only", "--no-ext-diff", "--ignore-submodules=all"])) ||
        (await run(["ls-files", "--others", "--exclude-standard"]))
      )
        throw storeError("INVALID_STAGE", "explicit commit paths must cover all current source changes")
      const tree = await run(["write-tree"])
      const baselineTree = await OrynGit.read(directory, ["rev-parse", `${attempt.baselineSha}^{tree}`])
      if (tree === baselineTree) throw storeError("INVALID_STAGE", "candidate commit has no source changes")
      if (replay && tree !== before.tree)
        throw storeError("INVALID_STAGE", "source differs from the interrupted Host commit")
      const candidateSha = replay
        ? before.sha
        : await run(["commit-tree", tree, "-p", attempt.baselineSha], message + "\n")
      if (!replay) await run(["update-ref", `refs/heads/${branch}`, candidateSha, before.sha])
      await run(["read-tree", candidateSha], undefined, false)
      await OrynCandidate.verify({ assignment, attempt, candidateSha, localBranch: branch })
      return { candidateSha, localBranch: branch, replayed: replay }
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }
}
