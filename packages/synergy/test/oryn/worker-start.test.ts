import { expect, spyOn, test } from "bun:test"
import { Worktree } from "../../src/project/worktree"
import { Storage } from "../../src/storage/storage"
import { ConfigDomain } from "../../src/config/domain"
import { Config } from "../../src/config/config"
import { BossService } from "../../src/boss/boss"
import { OrynService } from "../../src/oryn/service"
import { OrynPath } from "../../src/oryn/path"
import { OrynStore } from "../../src/oryn/store"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { SessionManager } from "../../src/session/manager"
import { globalConfig, tmpdir } from "./fixture"

async function fixture(
  fn: (input: {
    rootId: string
    caseId: string
    attemptId: string
    dispatch: () => ReturnType<typeof OrynService.dispatch>
  }) => Promise<void>,
) {
  await using repo = await tmpdir({ git: true })
  await using config = await globalConfig({
    oryn: {
      enabled: true,
      routes: [{ feishuAccount: "test", repoAlias: "fixture" }],
      repositories: { fixture: { owner: "acme", repo: "fixture", directory: repo.path } },
    },
  })
  await Bun.$`git remote add origin https://github.com/acme/fixture.git`.cwd(repo.path).quiet()
  await Bun.$`git update-ref refs/remotes/origin/dev HEAD`.cwd(repo.path).quiet()
  const scope = (await Scope.fromDirectory(repo.path)).scope
  await ScopeContext.provide({
    scope,
    fn: async () => {
      const identity = { provider: "feishu" as const, accountId: "test", chatId: repo.path }
      const { claim } = await OrynStore.claimSource({ identity, requestKey: "worker-start" })
      await OrynStore.createCase({
        caseId: claim.caseId,
        kind: "bug",
        summary: "recover worker creation",
        repoAlias: "fixture",
        sourceKeyHash: claim.sourceKey,
      })
      await OrynStore.recordSource({ identity })
      await OrynStore.linkSourceToCase(claim.sourceKey, claim.caseId)
      const root = await OrynService.openEngineeringSession({
        caseId: claim.caseId,
        identity,
        baselineSha: (await Bun.$`git rev-parse HEAD`.cwd(repo.path).text()).trim(),
      })
      const wake = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
      try {
        await fn({
          rootId: root.sessionID,
          caseId: claim.caseId,
          attemptId: root.attemptId,
          dispatch: () =>
            OrynService.dispatch({
              callerSessionID: root.sessionID,
              caseId: claim.caseId,
              stage: "repro",
              requestKey: "repro",
            }),
        })
      } finally {
        for (const session of [...(await Session.children(root.sessionID)), await Session.get(root.sessionID)])
          await SessionInbox.removeByMode(session.id, ["task", "steer", "context"])
        await Session.remove(root.sessionID)
        const record = (await OrynStore.getCase(claim.caseId))!
        await OrynStore.mutateCase(record.id, record.revision, (value) => ({ ...value, control: "closed" }))
        wake.mockRestore()
      }
    },
  })
}

test("dispatch reserves the worker identity before a completed spawn loses its response", async () => {
  await fixture(async (input) => {
    const spawn = BossService.spawn
    let workerId = ""
    const failure = spyOn(BossService, "spawn").mockImplementation(async (...args) => {
      const worker = await spawn(...args)
      workerId = worker.id
      throw new Error("injected lost spawn response")
    })
    try {
      await expect(input.dispatch()).rejects.toThrow("injected lost spawn response")
    } finally {
      failure.mockRestore()
    }
    const assignment = (await OrynStore.listAssignments(input.caseId))[0]
    expect(assignment.sessionId).toBe(workerId)
    const recovered = await input.dispatch()
    expect(recovered).toMatchObject({ assignmentId: assignment.id, workerSessionId: workerId, deduped: true })
    expect(await Session.children(input.rootId)).toHaveLength(1)
    expect(await SessionInbox.list(workerId)).toHaveLength(1)
  })
})

test("dispatch replay wakes an existing undelivered task without another inbox item", async () => {
  await fixture(async (input) => {
    const initial = await input.dispatch()
    const wake = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
    wake.mockClear()
    try {
      expect(await input.dispatch()).toMatchObject({ workerSessionId: initial.workerSessionId, deduped: true })
      expect(wake.mock.calls.some(([id]) => id === initial.workerSessionId)).toBe(true)
      expect(await SessionInbox.list(initial.workerSessionId)).toHaveLength(1)
    } finally {
      wake.mockRestore()
    }
  })
})

test("a worker Session with a missing creation index resumes under its reserved identity", async () => {
  await fixture(async (input) => {
    const write = Storage.write
    const failure = spyOn(Storage, "write").mockImplementation(async (key, value, options) => {
      if (key[0] === "session_index" && key[1] !== input.rootId) throw new Error("injected missing worker index")
      return write(key, value, options)
    })
    try {
      await expect(input.dispatch()).rejects.toThrow("injected missing worker index")
    } finally {
      failure.mockRestore()
    }
    const reserved = (await OrynStore.listAssignments(input.caseId))[0].sessionId
    expect(reserved).toBeDefined()
    const recovered = await input.dispatch()
    expect(recovered.workerSessionId).toBe(reserved!)
    expect(await Session.children(input.rootId)).toHaveLength(1)
    expect((await Session.get(recovered.workerSessionId)).workspace?.type).toBe("git_worktree")
  })
})

test("a persisted worker worktree is rebound after interruption before Session binding", async () => {
  await fixture(async (input) => {
    const create = Worktree.create
    let directory = ""
    const failure = spyOn(Worktree, "create").mockImplementation(
      Object.assign(
        async (options: Parameters<typeof create>[0]) => {
          const workspace = await create({ ...options, baseRef: options?.baseRef ?? "current", bind: false })
          directory = workspace.path
          throw new Error("injected interruption before binding")
        },
        { force: create.force, schema: create.schema },
      ),
    )
    try {
      await expect(input.dispatch()).rejects.toThrow("injected interruption before binding")
    } finally {
      failure.mockRestore()
    }
    const reserved = (await OrynStore.listAssignments(input.caseId))[0].sessionId!
    expect((await Session.get(reserved)).workspace?.type).not.toBe("git_worktree")
    const recovered = await input.dispatch()
    expect(recovered.workerSessionId).toBe(reserved)
    expect((await Session.get(reserved)).workspace?.path).toBe(directory)
    expect(await Worktree.ownedBySession(reserved)).toHaveLength(1)
    expect((await OrynStore.listAssignments(input.caseId))[0].workspaceRef).toBe(directory)
  })
})

test("startup recovery resumes a reserved dispatch from the global Scope and repeated runs dedupe", async () => {
  await fixture(async (input) => {
    const failure = spyOn(BossService, "spawn").mockRejectedValue(new Error("injected spawn unavailable"))
    try {
      await expect(input.dispatch()).rejects.toThrow("injected spawn unavailable")
    } finally {
      failure.mockRestore()
    }
    const reserved = (await OrynStore.listAssignments(input.caseId))[0].sessionId!
    for (let index = 0; index < 2; index++) {
      const recovered = await ScopeContext.provide({ scope: Scope.home(), fn: () => OrynService.recoverWorkers() })
      expect(recovered.recovered).toBeGreaterThan(0)
      expect((await OrynStore.listAssignments(input.caseId))[0].sessionId).toBe(reserved)
      expect(await Session.children(input.rootId)).toHaveLength(1)
      expect(await SessionInbox.list(reserved)).toHaveLength(1)
    }
  })
})

test("parallel replay creates one worker and one task for the assignment", async () => {
  await fixture(async (input) => {
    const results = await Promise.all([input.dispatch(), input.dispatch(), input.dispatch()])
    expect(new Set(results.map((result) => result.workerSessionId)).size).toBe(1)
    expect(new Set(results.map((result) => result.assignmentId)).size).toBe(1)
    expect(results.filter((result) => !result.deduped)).toHaveLength(1)
    expect(await Session.children(input.rootId)).toHaveLength(1)
    expect(await SessionInbox.list(results[0].workerSessionId)).toHaveLength(1)
  })
})

test("recovery does not launch reserved workers after human takeover or disabled installation", async () => {
  await fixture(async (input) => {
    const failure = spyOn(BossService, "spawn").mockRejectedValue(new Error("injected spawn unavailable"))
    try {
      await expect(input.dispatch()).rejects.toThrow("injected spawn unavailable")
    } finally {
      failure.mockRestore()
    }
    const domain = ConfigDomain.byKey.get("oryn")!.id
    const before = await Config.domainGet(domain)
    try {
      await Config.domainUpdate(
        domain,
        { ...before, oryn: { ...before.oryn, enabled: false } },
        { mode: "replace-domain" },
      )
      expect(await OrynService.recoverWorkers()).toEqual({ recovered: 0, failed: 0 })
    } finally {
      await Config.domainUpdate(domain, before, { mode: "replace-domain" })
    }
    await OrynStore.requestHandoff(input.caseId, "Operator must inspect the environment")
    await OrynService.recoverWorkers()
    expect(await Session.children(input.rootId)).toHaveLength(0)
  })
})

test("dispatch repairs the Attempt link after Assignment persistence outlives its index write", async () => {
  await fixture(async (input) => {
    const write = Storage.write
    const failure = spyOn(Storage, "write").mockImplementation(async (key, value, options) => {
      if (key.join("/") === OrynPath.attempt(input.caseId, input.attemptId).join("/"))
        throw new Error("injected missing Attempt assignment link")
      return write(key, value, options)
    })
    try {
      await expect(input.dispatch()).rejects.toThrow("injected missing Attempt assignment link")
    } finally {
      failure.mockRestore()
    }
    const existing = (await OrynStore.listAssignments(input.caseId))[0]
    expect((await OrynStore.getAttempt(input.caseId, input.attemptId))?.assignmentIds).toEqual([])
    const recovered = await input.dispatch()
    expect(recovered.assignmentId).toBe(existing.id)
    expect((await OrynStore.getAttempt(input.caseId, input.attemptId))?.assignmentIds).toEqual([existing.id])
    expect(await OrynStore.listAssignments(input.caseId)).toHaveLength(1)
  })
})

test("worker replay preserves uncommitted work and rejects changed reserved roles", async () => {
  await fixture(async (input) => {
    const initial = await input.dispatch()
    const worker = await Session.get(initial.workerSessionId)
    await Bun.write(`${worker.workspace!.path}/experiment.txt`, "keep this reproduction experiment")
    expect((await input.dispatch()).workerSessionId).toBe(worker.id)
    expect(await Bun.file(`${worker.workspace!.path}/experiment.txt`).text()).toBe("keep this reproduction experiment")
    await Session.update(worker.id, (record) => {
      record.agentOverride = "oryn-code"
    })
    await expect(input.dispatch()).rejects.toMatchObject({ code: "spawn_identity_mismatch" })
    await expect(
      OrynStore.setAssignmentSession(input.caseId, initial.assignmentId, input.rootId),
    ).rejects.toMatchObject({ data: { code: "INVALID_STAGE" } })
    expect(await Session.children(input.rootId)).toHaveLength(1)
  })
})

test("startup recovery honors changed repository ownership before spawning", async () => {
  await fixture(async (input) => {
    const failure = spyOn(BossService, "spawn").mockRejectedValue(new Error("injected spawn unavailable"))
    try {
      await expect(input.dispatch()).rejects.toThrow("injected spawn unavailable")
    } finally {
      failure.mockRestore()
    }
    const root = await Session.get(input.rootId)
    await Bun.$`git remote set-url origin https://github.com/acme/different-repository.git`
      .cwd(root.scope.directory)
      .quiet()
    expect((await OrynService.recoverWorkers()).failed).toBeGreaterThan(0)
    expect(await Session.children(input.rootId)).toHaveLength(0)
  })
})

test("startup recovery preserves consumed task identity without delivering it again", async () => {
  await fixture(async (input) => {
    const initial = await input.dispatch()
    const item = (await SessionInbox.list(initial.workerSessionId))[0]
    await SessionInbox.materializeItem(item)
    await SessionInbox.commitReady(initial.workerSessionId, [item.id])
    await OrynService.recoverWorkers()
    expect(await SessionInbox.list(initial.workerSessionId)).toHaveLength(0)
    const messages = await Session.messages({ sessionID: initial.workerSessionId })
    expect(messages.filter((message) => message.info.role === "user")).toHaveLength(1)
    expect(await Session.children(input.rootId)).toHaveLength(1)
  })
})

test("a missing previously bound worker is not recreated with empty history", async () => {
  await fixture(async (input) => {
    const initial = await input.dispatch()
    await Session.remove(initial.workerSessionId)
    await expect(input.dispatch()).rejects.toMatchObject({ code: "spawn_missing" })
    expect(await Session.children(input.rootId)).toHaveLength(0)
    expect((await OrynStore.getAssignment(input.caseId, initial.assignmentId))?.sessionId).toBe(initial.workerSessionId)
  })
})

test("dispatch refuses to replace a changed Assignment workspace reference", async () => {
  await fixture(async (input) => {
    const initial = await input.dispatch()
    const worker = await Session.get(initial.workerSessionId)
    const changed = `${worker.workspace!.path}/different-workspace`
    await OrynStore.setAssignmentWorkspace(input.caseId, initial.assignmentId, changed)
    await expect(input.dispatch()).rejects.toMatchObject({ data: { code: "INVALID_STAGE" } })
    expect((await OrynStore.getAssignment(input.caseId, initial.assignmentId))?.workspaceRef).toBe(changed)
    expect(await Session.children(input.rootId)).toHaveLength(1)
  })
})
