import { z } from "zod"
import { OrynGit } from "./git"
import { OrynStore, storeError } from "./store"
import { OrynCandidate } from "./candidate"
import { OrynConfig } from "./config"
import { OrynGithubStore } from "./github-store"
import { Storage } from "../storage/storage"
import { OrynPath } from "./path"
import { Lock } from "../util/lock"

const State = z
  .object({
    schemaVersion: z.literal(1),
    headSha: z.string(),
    targetBaseSha: z.string(),
    state: z.enum(["prepared", "conflicts", "committed", "aborted"]),
    conflicts: z.array(z.string()),
  })
  .strict()
let resolveTarget:
  | ((repository: string, branch: string, directory: string, headSha: string, signal: AbortSignal) => Promise<string>)
  | undefined

export namespace OrynIntegration {
  export function setTargetResolver(value: typeof resolveTarget) {
    resolveTarget = value
  }
  export const key = (caseId: string, attemptId: string) => [...OrynPath.caseRoot(caseId), "integrations", attemptId]
  export async function get(caseId: string, attemptId: string) {
    return Storage.read(key(caseId, attemptId)).then(
      (raw) => State.parse(raw),
      (error) => {
        if (error instanceof Storage.NotFoundError) return undefined
        throw error
      },
    )
  }
  async function git(directory: string, args: string[], signal?: AbortSignal) {
    signal?.throwIfAborted()
    const child = Bun.spawn(["git", ...args], {
      cwd: directory,
      env: {
        ...OrynGit.environment(),
        GIT_MERGE_AUTOEDIT: "no",
        GIT_COMMITTER_NAME: "synergy-agent",
        GIT_COMMITTER_EMAIL: "299070056+synergy-agent@users.noreply.github.com",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
      signal,
      killSignal: "SIGKILL",
    })
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
    signal?.throwIfAborted()
    return { exitCode, stdout }
  }
  // Inspect without rebasing merely because the target advanced.
  // https://github.com/openclaw/openclaw/blob/main/scripts/pr-lib/prepare-core.sh
  export async function inspect(directory: string, headSha: string, targetBaseSha: string, signal?: AbortSignal) {
    const drivers = await git(directory, [
      "config",
      "--local",
      "--get-regexp",
      "^(merge\\..*\\.driver|filter\\..*\\.(clean|smudge|process))$",
    ])
    if (drivers.exitCode === 0)
      throw storeError(
        "ENVIRONMENT_UNAVAILABLE",
        "Host integration does not execute repository-configured merge or filter drivers",
      )
    if (drivers.exitCode !== 1)
      throw storeError("ENVIRONMENT_UNAVAILABLE", "Git integration configuration could not be checked")
    const versions = await OrynGit.versions(directory, targetBaseSha, headSha)
    const result = await git(
      directory,
      ["merge-tree", "--write-tree", "--name-only", "-z", headSha, targetBaseSha],
      signal,
    )
    if (![0, 1].includes(result.exitCode))
      throw storeError("ENVIRONMENT_UNAVAILABLE", "Git could not inspect target integration")
    const lines = result.stdout.split("\0")
    if (!/^[a-f0-9]{40,64}$/.test(lines[0]!))
      throw storeError("ENVIRONMENT_UNAVAILABLE", "Git returned incomplete integration evidence")
    const conflicts = result.exitCode === 1 ? lines.slice(1).slice(0, lines.slice(1).indexOf("")) : []
    if (result.exitCode === 1 && !conflicts.length)
      throw storeError("ENVIRONMENT_UNAVAILABLE", "Git could not enumerate integration conflicts")
    return { ...versions, treeSha: lines[0]!, conflicts }
  }
  export async function run(input: {
    callerSessionID: string
    caseId: string
    action: "inspect" | "start" | "abort"
    abort: AbortSignal
  }) {
    const binding = await OrynStore.sessionSourceBinding(input.callerSessionID)
    const record = await OrynStore.getCase(input.caseId)
    const config = await OrynConfig.info()
    const repo = record && config?.repositories?.[record.repoAlias]
    if (
      !config?.enabled ||
      binding?.caseId !== input.caseId ||
      !["worker", "engineering"].includes(binding.role) ||
      record?.control !== "active" ||
      !record.activeAttemptId ||
      !repo?.directory
    )
      throw storeError("NOT_AUTHORIZED", "Integration requires an active bound engineering task")
    const attempt = await OrynStore.getAttempt(record.id, record.activeAttemptId)
    if (!attempt) throw storeError("INVALID_STAGE", "Integration requires an active Attempt")
    const work = await OrynGithubStore.get(record.id)
    if (work?.mode === "review" && input.action !== "inspect")
      throw storeError("NOT_AUTHORIZED", "External review cannot modify a contributor branch")
    const assignment = (await OrynStore.listAssignments(record.id)).find(
      (item) =>
        item.sessionId === input.callerSessionID && item.attemptId === attempt.id && item.epoch === record.epoch,
    )
    if (
      input.action !== "inspect" &&
      (!assignment || assignment.stage !== "code" || attempt.candidateSha || assignment.acceptedReportId)
    )
      throw storeError(
        "INVALID_STAGE",
        "Start or abort integration in the unfrozen code assignment; rework a frozen candidate first",
      )
    if (!resolveTarget && input.action !== "abort")
      throw storeError("ENVIRONMENT_UNAVAILABLE", "Repository target resolver is unavailable")
    const headSha = attempt.candidateSha ?? attempt.baselineSha
    const targetBaseSha =
      input.action === "abort"
        ? headSha
        : await resolveTarget!(
            `${repo.owner}/${repo.repo}`,
            repo.baseBranch ?? "dev",
            repo.directory,
            headSha,
            input.abort,
          )
    if (input.action === "inspect")
      return { ...(await inspect(repo.directory, headSha, targetBaseSha, input.abort)), state: "inspected" as const }
    using lock = await Lock.write(`oryn-case:${record.id}`)
    const fresh = await OrynStore.getCase(record.id)
    if (fresh?.control !== "active" || fresh.epoch !== record.epoch || fresh.activeAttemptId !== attempt.id)
      throw storeError("HUMAN_OWNED", "Integration ownership changed")
    const { directory } = await OrynCandidate.workspace(assignment!)
    const previous = await get(record.id, attempt.id)
    if (input.action === "abort") {
      if (!previous || previous.headSha !== attempt.baselineSha || previous.state === "committed")
        throw storeError("INVALID_STAGE", "No owned integration to abort")
      if ((await git(directory, ["merge", "--abort"], input.abort)).exitCode)
        throw storeError("INVALID_STAGE", "Integration could not abort; preserve the workspace for inspection")
      await Storage.write(key(record.id, attempt.id), { ...previous, state: "aborted" })
      return { state: "aborted" }
    }
    if (previous && ["prepared", "conflicts"].includes(previous.state)) {
      const mergeHead = await OrynGit.read(directory, ["rev-parse", "--verify", "MERGE_HEAD"]).catch(() => undefined)
      if (mergeHead === previous.targetBaseSha) {
        const recovered = { ...previous, state: "conflicts" as const }
        await Storage.write(key(record.id, attempt.id), recovered)
        return recovered
      }
      if (previous.state === "conflicts")
        throw storeError("INVALID_STAGE", "Owned merge state disappeared; retain workspace for inspection")
    }
    const snapshot = await OrynGit.snapshot(directory)
    if (snapshot.sha !== attempt.baselineSha || snapshot.dirty)
      throw storeError("INVALID_STAGE", "Prepare integration before editing the clean code workspace")
    const inspection = await inspect(
      directory,
      attempt.baselineSha,
      previous?.state === "prepared" ? previous.targetBaseSha : targetBaseSha,
      input.abort,
    )
    if (!inspection.conflicts.length) return { ...inspection, state: "compatible" }
    const state = State.parse({
      schemaVersion: 1,
      headSha: attempt.baselineSha,
      targetBaseSha: inspection.targetBaseSha,
      conflicts: inspection.conflicts,
      state: "prepared",
    })
    await Storage.write(key(record.id, attempt.id), state)
    const merged = await git(directory, ["merge", "--no-commit", "--no-ff", state.targetBaseSha], input.abort)
    const mergeHead = await OrynGit.read(directory, ["rev-parse", "--verify", "MERGE_HEAD"])
    if (![0, 1].includes(merged.exitCode) || mergeHead !== state.targetBaseSha)
      throw storeError("ENVIRONMENT_UNAVAILABLE", "Integration preparation is incomplete; inspect retained Git state")
    await Storage.write(key(record.id, attempt.id), { ...state, state: "conflicts" })
    return {
      ...state,
      state: "conflicts",
      changedFiles: (await OrynGit.read(directory, ["diff", "HEAD", "--name-only"])).split("\n"),
    }
  }
}
