import path from "node:path"
import { realpath } from "node:fs/promises"
import { Identifier } from "../id/id"
import { Scope } from "../scope"
import { ScopeContext } from "../scope/context"
import { Session } from "../session"
import { SessionInbox } from "../session/inbox"
import { SessionInteraction } from "../session/interaction"
import { SessionManager } from "../session/manager"
import { Storage } from "../storage/storage"
import { Lock } from "../util/lock"
import { Log } from "../util/log"
import { OrynConfig } from "./config"
import { OrynPath } from "./path"
import { EngineeringStart, type SourceIdentity } from "./schema"
import { OrynStore, storeError } from "./store"

async function git(directory: string, args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
  const child = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    cwd: directory,
    env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "ignore",
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    killSignal: "SIGKILL",
  })
  const [exit, output] = await Promise.all([child.exited, new Response(child.stdout).text()])
  if (exit !== 0) throw storeError("ENVIRONMENT_UNAVAILABLE", "repository or baseline is unavailable")
  return output.trim()
}

function matchesRepository(remote: string, owner: string, repo: string): boolean {
  return [
    `https://github.com/${owner}/${repo}`,
    `ssh://git@github.com/${owner}/${repo}`,
    `git@github.com:${owner}/${repo}`,
  ].includes(remote.replace(/\.git$/, ""))
}

export namespace OrynEngineering {
  const log = Log.create({ service: "oryn.engineering" })
  export type Result = { state: "started" | "blocked"; reason?: string; sessionID?: string; attemptId?: string }

  export async function get(caseId: string): Promise<EngineeringStart | undefined> {
    try {
      return EngineeringStart.parse(await Storage.read(OrynPath.engineeringStart(caseId)))
    } catch (error) {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    }
  }

  async function save(record: EngineeringStart): Promise<EngineeringStart> {
    const next = EngineeringStart.parse({ ...record, updatedAt: Date.now() })
    await Storage.write(OrynPath.engineeringStart(record.caseId), next)
    return next
  }

  async function reserve(caseId: string): Promise<EngineeringStart> {
    const existing = await get(caseId)
    if (existing) return existing
    const record = await OrynStore.getCase(caseId)
    if (!record) throw storeError("NOT_AUTHORIZED", "case not found")
    return save({
      schemaVersion: 1,
      caseId,
      sessionId: record.engineeringSessionId ?? Identifier.descending("session"),
      attemptId: record.activeAttemptId ?? Identifier.ascending("oryn_attempt"),
      state: "pending",
      updatedAt: Date.now(),
    })
  }

  async function openReserved(
    start: EngineeringStart,
    input: { identity: SourceIdentity; scope: Scope; baselineSha: string; baseBranchSha?: string },
  ) {
    if (start.scopeId && start.scopeId !== input.scope.id)
      throw storeError("NOT_AUTHORIZED", "engineering scope changed")
    const baselineSha = start.baselineSha ?? input.baselineSha
    start = await save({
      ...start,
      directory: input.scope.directory,
      scopeId: input.scope.id,
      baselineSha,
      state: "pending",
      reason: undefined,
    })
    return ScopeContext.provide({
      scope: input.scope,
      workspace: { type: "main", path: input.scope.directory, scopeID: input.scope.id },
      fn: async () => {
        let session = await Session.recoverCreation(input.scope, start.sessionId)
        if (!session)
          session = await Session.create({
            id: start.sessionId,
            scope: input.scope,
            title: `Oryn ${start.caseId}`,
            agentOverride: "oryn-work",
            controlProfile: "autonomous",
            interaction: SessionInteraction.unattended("oryn"),
            completionNotice: { silent: true },
            workflow: { kind: "boss", role: "boss" },
          })
        if (
          session.time.archived ||
          session.scope.id !== input.scope.id ||
          session.agentOverride !== "oryn-work" ||
          session.parentID ||
          session.workflow?.kind !== "boss" ||
          session.workflow.role !== "boss"
        ) {
          throw storeError("NOT_AUTHORIZED", "engineering session does not match its reserved identity")
        }
        await OrynStore.attachEngineeringSession(start.caseId, session.id)
        const binding = await OrynStore.sessionSourceBinding(session.id)
        if (binding && (binding.caseId !== start.caseId || binding.role !== "engineering"))
          throw storeError("NOT_AUTHORIZED", "engineering source binding changed")
        if (!binding)
          await OrynStore.bindSessionSource({
            sessionID: session.id,
            identity: input.identity,
            caseId: start.caseId,
            role: "engineering",
          })
        const attempt = await OrynStore.ensureAttempt(start.caseId, {
          attemptId: start.attemptId,
          baselineSha,
          baseBranchSha: input.baseBranchSha ?? baselineSha,
        })
        await save({ ...start, attemptId: attempt.id })
        return { sessionID: session.id, attemptId: attempt.id }
      },
    })
  }

  export async function open(input: {
    caseId: string
    identity: SourceIdentity
    baselineSha: string
    baseBranchSha?: string
  }) {
    if (!(await OrynConfig.enabled())) throw storeError("NOT_AUTHORIZED", "oryn runtime is disabled")
    using _lock = await Lock.write(`oryn-engineering:${input.caseId}`)
    return openReserved(await reserve(input.caseId), { ...input, scope: ScopeContext.current.scope })
  }

  export async function start(caseId: string): Promise<Result> {
    const config = await OrynConfig.info()
    if (!config?.enabled) return { state: "blocked", reason: "oryn_disabled" }
    using _lock = await Lock.write(`oryn-engineering:${caseId}`)
    const record = await OrynStore.getCase(caseId)
    if (!record) throw storeError("NOT_AUTHORIZED", "case not found")
    if (record.control !== "active") return { state: "blocked", reason: "case_not_active" }
    let start = await reserve(caseId)
    const block = async (reason: string): Promise<Result> => {
      await save({ ...start, state: "blocked", reason })
      return { state: "blocked", reason }
    }
    const repository = config.repositories?.[record.repoAlias]
    if (!repository?.directory || !path.isAbsolute(repository.directory)) return block("repository_directory_required")
    const sources = await Promise.all(record.sourceIds.map((key) => OrynStore.getSource(key)))
    const source = sources.find(
      (item) =>
        item &&
        item.identity.provider === "feishu" &&
        OrynConfig.resolveRepoAlias(config, { accountId: item.identity.accountId, chatId: item.identity.chatId }) ===
          record.repoAlias,
    )
    if (!source) return block("source_route_unavailable")
    let directory: string
    let baselineSha: string
    try {
      directory = await realpath(repository.directory)
      if (start.directory && start.directory !== directory) return block("repository_directory_changed")
      const remote = await git(directory, ["remote", "get-url", "origin"])
      if (!matchesRepository(remote, repository.owner, repository.repo)) return block("repository_origin_mismatch")
      const root = await git(directory, ["rev-parse", "--show-toplevel"])
      if ((await realpath(root)) !== directory) return block("repository_root_required")
      const current = record.activeAttemptId ? await OrynStore.getAttempt(caseId, record.activeAttemptId) : undefined
      baselineSha =
        start.baselineSha ??
        current?.baselineSha ??
        (await git(directory, [
          "rev-parse",
          "--verify",
          `refs/remotes/origin/${repository.baseBranch ?? "dev"}^{commit}`,
        ]))
      if (!/^[0-9a-f]{40,64}$/.test(baselineSha)) return block("baseline_unavailable")
      await git(directory, ["cat-file", "-e", `${baselineSha}^{commit}`])
    } catch (error) {
      if (error instanceof Error) return block("repository_unavailable")
      throw error
    }
    const { scope } = await Scope.fromDirectory(directory)
    if (scope.type !== "project" || scope.directory !== directory) return block("repository_scope_unavailable")
    if (start.state === "started") {
      try {
        const session = await Session.get(start.sessionId)
        if (session.time.archived || session.scope.id !== scope.id) return block("engineering_session_unavailable")
      } catch (error) {
        if (error instanceof Storage.NotFoundError) return block("engineering_session_unavailable")
        throw error
      }
      if (await SessionInbox.hasRunnableItem(start.sessionId, { allowSteer: true }))
        SessionManager.scheduleWake(start.sessionId, "oryn_recovery")
      return { state: "started", sessionID: start.sessionId, attemptId: start.attemptId }
    }
    await OrynStore.linkSourceToCase(source.key, caseId)
    const opened = await openReserved(start, { identity: source.identity, scope, baselineSha })
    start = (await get(caseId))!
    using _caseLock = await Lock.write(`oryn-case:${caseId}`)
    const latest = await OrynStore.getCase(caseId)
    if (latest?.control !== "active" || latest.epoch !== record.epoch) return block("case_control_changed")
    await ScopeContext.provide({
      scope,
      workspace: { type: "main", path: directory, scopeID: scope.id },
      fn: async () => {
        await SessionInbox.deliverUnique({
          sessionID: opened.sessionID,
          deliveryKey: `oryn-start:${caseId}`,
          mode: "task",
          message: {
            role: "user",
            agent: "oryn-work",
            origin: { type: "system", detail: "oryn_start" },
            visible: true,
            parts: [
              {
                type: "text",
                text: `Investigate Oryn case ${caseId}.\nAttempt: ${opened.attemptId}\nRepository: ${record.repoAlias}\nBaseline: ${baselineSha}\nSummary: ${record.summary}\nObserved: ${record.observed ?? "not supplied"}\nExpected: ${record.expected ?? "clarification required"}\nRead the current case and dispatch the next allowed stage. Worker reports arrive through Inbox; do not poll. If acceptance or environment is insufficient, request human handoff. Human merge is required.`,
              },
            ],
            metadata: { orynCaseId: caseId, orynAttemptId: opened.attemptId },
          },
        })
        await save({ ...start, state: "started", reason: undefined })
        SessionManager.scheduleWake(opened.sessionID, "oryn_start")
      },
    })
    return { state: "started", ...opened }
  }

  export async function recover() {
    if (!(await OrynConfig.enabled())) return { started: 0, blocked: 0, failed: 0 }
    const counts = { started: 0, blocked: 0, failed: 0 }
    const started = new Set<string>()
    for (const record of await OrynStore.listCases({ control: "active" })) {
      try {
        const result = await start(record.id)
        counts[result.state]++
        if (result.state === "started") started.add(record.id)
      } catch (error) {
        log.warn("engineering startup recovery failed", {
          caseId: record.id,
          error: error instanceof Error ? error.name : "unknown",
        })
        counts.failed++
      }
    }
    for (const claim of await OrynStore.incompleteClaims()) {
      if (started.has(claim.caseId))
        await OrynStore.updateClaim(claim.sourceKey, claim.requestKey, { state: "completed" })
    }
    return counts
  }
}
