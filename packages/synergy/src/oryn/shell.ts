import { existsSync } from "node:fs"
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, sep } from "node:path"
import { isOrynAgent } from "../agent/builtin-oryn"
import { Session } from "../session"
import { SandboxBackend } from "../sandbox/backend"
import type { ProcessAccessPolicy } from "../tool/process/policy"
import type { BashExecutionPolicy } from "../tool/bash/policy"
import { OrynConfig } from "./config"
import { OrynGit } from "./git"
import { SYSTEM_READ_ROOTS } from "./sandbox"
import { OrynStore, storeError } from "./store"

export namespace OrynShell {
  async function owner(input: BashExecutionPolicy.Input) {
    input.abort.throwIfAborted()
    const binding = await OrynStore.sessionSourceBinding(input.sessionID)
    if (!binding && !isOrynAgent(input.agent)) return
    if (!binding || binding.role !== "worker" || !binding.caseId || !(await OrynConfig.enabled()))
      throw storeError("NOT_AUTHORIZED", "shell requires an enabled Oryn worker assignment")
    const record = await OrynStore.getCase(binding.caseId)
    const assignments = await OrynStore.listAssignments(binding.caseId)
    const assignment = assignments.find((item) => item.sessionId === input.sessionID)
    const session = await Session.get(input.sessionID)
    if (
      !record ||
      record.control !== "active" ||
      !assignment ||
      assignment.epoch !== record.epoch ||
      assignment.attemptId !== record.activeAttemptId ||
      assignment.acceptedReportId ||
      session.time.archived ||
      session.agentOverride !== assignment.agentId ||
      input.agent !== assignment.agentId ||
      session.workspace?.type !== "git_worktree" ||
      !assignment.workspaceRef
    )
      throw storeError("NOT_AUTHORIZED", "shell assignment is inactive or its worker identity changed")
    const attempt = await OrynStore.getAttempt(record.id, assignment.attemptId)
    if (!attempt || !["open", "candidate_frozen"].includes(attempt.disposition))
      throw storeError("INVALID_STAGE", "shell Attempt is not active")
    const directory = await realpath(session.workspace.path)
    if (directory !== (await realpath(input.workspace)) || directory !== (await realpath(assignment.workspaceRef)))
      throw storeError("NOT_AUTHORIZED", "shell workspace differs from its assignment")
    const common = await realpath(
      await OrynGit.read(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    )
    if (
      common !==
      (await realpath(
        await OrynGit.read(session.scope.directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      ))
    )
      throw storeError("NOT_AUTHORIZED", "shell workspace belongs to a different repository")
    const branch = await OrynGit.read(directory, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    if (branch !== session.workspace.branch)
      throw storeError("INVALID_STAGE", "shell branch differs from its assignment")
    await OrynGit.read(directory, ["check-ref-format", `refs/heads/${branch}`])
    const writable = !attempt.candidateSha && ["code", "repro"].includes(assignment.stage)
    return { directory, common, branch, writable }
  }

  export async function processAccess(
    input: ProcessAccessPolicy.Input,
  ): Promise<ProcessAccessPolicy.Access | undefined> {
    input.abort.throwIfAborted()
    const binding = await OrynStore.sessionSourceBinding(input.sessionID)
    if (!binding && !isOrynAgent(input.agent)) return
    if (!binding || binding.role !== "worker" || !binding.caseId)
      throw storeError("NOT_AUTHORIZED", "process access requires an Oryn worker assignment")
    const assignment = (await OrynStore.listAssignments(binding.caseId)).find(
      (item) => item.sessionId === input.sessionID,
    )
    const session = await Session.get(input.sessionID)
    if (!assignment || input.agent !== assignment.agentId || session.agentOverride !== assignment.agentId)
      throw storeError("NOT_AUTHORIZED", "process assignment identity changed")
    if (input.action === "write" || input.action === "send-keys") {
      const work = await owner(input)
      if (!work?.writable) throw storeError("INVALID_STAGE", "process input requires an active writable assignment")
    }
    return { sessionID: input.sessionID }
  }

  export async function resolve(input: BashExecutionPolicy.Input): Promise<BashExecutionPolicy.Policy | undefined> {
    if (!(await owner(input))) return
    return {
      prepare: async (command) => {
        const work = await owner(input)
        if (!work) throw storeError("NOT_AUTHORIZED", "shell assignment binding disappeared")
        const cwd = await realpath(command.cwd ?? work.directory)
        const cwdPath = relative(work.directory, cwd)
        if (cwdPath === ".." || cwdPath.startsWith(`..${sep}`) || isAbsolute(cwdPath))
          throw storeError("NOT_AUTHORIZED", "shell cwd is outside the assigned workspace")
        const home = await realpath(await mkdtemp(join(tmpdir(), "oryn-shell-")))
        const dispose = () => rm(home, { recursive: true, force: true })
        try {
          const gitDirectory = join(home, "git")
          const objects = await realpath(join(work.common, "objects"))
          const objectPath = relative(work.common, objects)
          if (objectPath === ".." || objectPath.startsWith(`..${sep}`) || isAbsolute(objectPath))
            throw storeError("ENVIRONMENT_UNAVAILABLE", "Git object store is outside the approved repository")
          await mkdir(join(gitDirectory, "objects", "info"), { recursive: true })
          const ref = join(gitDirectory, "refs", "heads", work.branch)
          await mkdir(join(ref, ".."), { recursive: true })
          const head = await OrynGit.read(work.directory, ["rev-parse", "--verify", "HEAD^{commit}"])
          const format = await OrynGit.read(work.directory, ["rev-parse", "--show-object-format"])
          if (!["sha1", "sha256"].includes(format))
            throw storeError("ENVIRONMENT_UNAVAILABLE", "unsupported Git object format")
          await Promise.all([
            writeFile(join(gitDirectory, "HEAD"), `ref: refs/heads/${work.branch}\n`),
            writeFile(ref, `${head}\n`),
            writeFile(join(gitDirectory, "objects", "info", "alternates"), `${objects}\n`),
            writeFile(
              join(gitDirectory, "config"),
              `[core]\nrepositoryformatversion = ${format === "sha256" ? 1 : 0}\nbare = false\n${format === "sha256" ? "[extensions]\nobjectFormat = sha256\n" : ""}`,
            ),
          ])
          const index = await OrynGit.read(work.directory, [
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "index",
          ])
          try {
            const actualIndex = await realpath(index)
            const indexPath = relative(work.common, actualIndex)
            if (indexPath === ".." || indexPath.startsWith(`..${sep}`) || isAbsolute(indexPath))
              throw storeError("ENVIRONMENT_UNAVAILABLE", "Git index is outside the approved repository")
            await copyFile(actualIndex, join(gitDirectory, "index"))
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
          }
          const searchPath = (process.env.PATH ?? "").split(":").filter(isAbsolute).join(":")
          const binaries = [
            process.execPath,
            ...["bun", "node"].flatMap((name) => Bun.which(name, { PATH: searchPath }) ?? []),
          ]
          const shell = await realpath("/bin/bash")
          const runtime = [...SYSTEM_READ_ROOTS, ...binaries].filter(existsSync)
          const readable = [...new Set([...runtime, ...(await Promise.all(runtime.map((file) => realpath(file))))])]
          input.abort.throwIfAborted()
          const wrapper = SandboxBackend.prepareWrapper({
            command: shell,
            args: ["-c", 'cd "$1" && exec "$2" -c "$3"', "oryn-shell", cwd, shell, command.command],
            workspace: work.directory,
            executionCwd: home,
            sandboxMode: work.writable ? "workspace_write" : "read_only",
            permissionProfile: {
              fileSystem: {
                workspace: work.directory,
                readableRoots: [work.directory, objects, ...readable, ...command.extraReadRoots],
                writableRoots: [home, ...(work.writable ? [work.directory] : [])],
                readOnlySubpaths: [],
                unreadableGlobs: [],
                protectedMetadataNames: [".git", ".agents", ".codex"],
                protectedPaths: [],
                dataDenyRoots: [],
                includePlatformDefaults: false,
              },
              network: { mode: "restricted", allowLocalBinding: false, allowedUnixSockets: [] },
            },
          })
          return {
            ...wrapper,
            environment: {
              ...OrynGit.environment(),
              PATH: searchPath,
              HOME: home,
              TMPDIR: home,
              TMP: home,
              TEMP: home,
              LANG: "C.UTF-8",
              RUST_LOG: "error",
              GIT_DIR: gitDirectory,
              GIT_WORK_TREE: work.directory,
            },
            dispose,
          }
        } catch (error) {
          await dispose()
          throw error
        }
      },
    }
  }
}
