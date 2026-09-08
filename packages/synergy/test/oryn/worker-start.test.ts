import "../../src/product-registration"
import { expect, spyOn, test } from "bun:test"
import { Worktree } from "../../src/project/worktree"
import { Storage } from "../../src/storage/storage"
import { ConfigDomain } from "../../src/config/domain"
import { Config } from "../../src/config/config"
import { BossService } from "../../src/boss/boss"
import { OrynOwnership } from "../../src/oryn/ownership"
import { OrynControl } from "../../src/oryn/control"
import { OrynBudget } from "../../src/oryn/budget"
import { OrynBudgetRuntime } from "../../src/oryn/budget-runtime"
import { OrynEngineering } from "../../src/oryn/engineering"
import { scriptedModel } from "./fixtures/model"
import { OrynService } from "../../src/oryn/service"
import { OrynPath } from "../../src/oryn/path"
import { OrynStore } from "../../src/oryn/store"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInvoke } from "../../src/session/invoke"
import { SessionInbox } from "../../src/session/inbox"
import { SessionManager } from "../../src/session/manager"
import { AgentTurnAdmission } from "../../src/session/agent-turn/admission"
import { globalConfig, tmpdir } from "./fixture"

async function fixture(
  fn: (input: {
    rootId: string
    caseId: string
    attemptId: string
    dispatch: () => ReturnType<typeof OrynService.dispatch>
  }) => Promise<void>,
  modelConfig?: Partial<Config.Info>,
  limits?: { maxCaseMinutes: number },
) {
  await using repo = await tmpdir({ git: true })
  await using config = await globalConfig({
    ...modelConfig,
    oryn: {
      enabled: true,
      routes: [{ feishuAccount: "test", repoAlias: "fixture" }],
      repositories: { fixture: { owner: "acme", repo: "fixture", directory: repo.path } },
      limits,
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

test("model admission derives engineering and QA workload from Host bindings", async () => {
  await fixture(async ({ rootId, caseId, dispatch }) => {
    const worker = await dispatch()
    const record = (await OrynStore.getCase(caseId))!
    const source = (await OrynStore.getSource(record.sourceIds[0]))!
    const qa = await Session.create({ title: "Capacity QA", agentOverride: "oryn" })
    const unbound = await Session.create({ title: "Unbound name", agentOverride: "oryn-work" })
    const background = (sessionID: string) =>
      AgentTurnAdmission.background({ kind: "session", scopeID: ScopeContext.current.scope.id, sessionID })
    try {
      await OrynStore.bindSessionSource({ sessionID: qa.id, identity: source.identity, role: "qa" })
      expect(await background(rootId)).toBe(true)
      expect(await background(worker.workerSessionId)).toBe(true)
      expect(await background(qa.id)).toBe(false)
      expect(await background(unbound.id)).toBe(false)
      expect(await AgentTurnAdmission.background({ kind: "operation", scopeID: "home", operationID: "capacity" })).toBe(
        false,
      )
      const current = (await Config.globalRaw()).oryn!
      const runtime = await Config.domainGet("runtime")
      await Config.domainUpdate(
        "runtime",
        { ...runtime, oryn: { ...current, enabled: false } },
        { mode: "replace-domain" },
      )
      expect(await background(rootId)).toBe(false)
    } finally {
      await Session.remove(qa.id)
      await Session.remove(unbound.id)
    }
  })
})

test("an expired Case cannot start another engineering or worker turn", async () => {
  await fixture(async ({ rootId, caseId, dispatch }) => {
    const worker = await dispatch()
    const record = (await OrynStore.getCase(caseId))!
    await OrynStore.mutateCase(caseId, record.revision, (value) => ({
      ...value,
      createdAt: Date.now() - 721 * 60_000,
    }))
    expect(await OrynControl.canRun(await Session.get(rootId))).toBe(false)
    expect(await OrynControl.canRun(await Session.get(worker.workerSessionId))).toBe(false)
    await expect(dispatch()).rejects.toMatchObject({ data: { code: "BUDGET_EXHAUSTED" } })
  })
})

test("the budget monitor stops work despite held delivery and notifies each Case once across restart", async () => {
  await fixture(
    async ({ rootId, caseId, dispatch }) => {
      const worker = await dispatch()
      const record = (await OrynStore.getCase(caseId))!
      const source = (await OrynStore.getSource(record.sourceIds[0]))!
      const qa = await Session.create({ title: "Budget QA", agentOverride: "oryn" })
      await OrynStore.bindSessionSource({ sessionID: qa.id, identity: source.identity, role: "qa" })
      await OrynStore.recordChannelTurn({
        sessionID: qa.id,
        rootID: "budget-turn",
        identity: source.identity,
        chatType: "group",
      })
      const delivered: { sourceKey: string; text: string }[] = []
      const releaseDelivery = Promise.withResolvers<void>()
      let secondary: string | undefined
      OrynService.setOutboxDeliverer(async ({ sourceKey, text }) => {
        delivered.push({ sourceKey, text })
        if (delivered.length === 1) await releaseDelivery.promise
      })
      const entered = Promise.withResolvers<void>()
      let cancelled = false
      const running = SessionManager.run(worker.workerSessionId, async (lease) => {
        entered.resolve()
        await new Promise<void>((resolve) =>
          lease.signal.addEventListener(
            "abort",
            () => {
              cancelled = true
              resolve()
            },
            { once: true },
          ),
        )
      })
      try {
        await entered.promise
        await OrynBudgetRuntime.start()
        await OrynStore.mutateCase(caseId, record.revision, (value) => ({ ...value, createdAt: Date.now() - 61_000 }))
        const deadline = Date.now() + 10_000
        while ((!cancelled || delivered.length === 0) && Date.now() < deadline) await Bun.sleep(20)
        expect(cancelled).toBe(true)
        await running
        expect(SessionManager.isRunning(worker.workerSessionId)).toBe(false)
        expect(await OrynControl.canRun(await Session.get(rootId))).toBe(false)
        expect(await OrynControl.canRun(await Session.get(qa.id))).toBeUndefined()
        const handed = (await OrynStore.getCase(caseId))!
        expect(handed).toMatchObject({ control: "human_owned", epoch: 1 })
        expect(handed.handoff?.reason).toContain("budget of 1 minutes")
        expect(delivered).toHaveLength(1)
        expect(delivered[0].text).toContain("budget of 1 minutes")
        const secondIdentity = { ...source.identity, messageId: "second-budget-case" }
        const secondSource = await OrynStore.recordSource({ identity: secondIdentity })
        await OrynStore.recordChannelTurn({
          sessionID: qa.id,
          rootID: "second-budget-turn",
          identity: secondIdentity,
          chatType: "group",
        })
        const second = await OrynStore.createCase({
          caseId: `case_${crypto.randomUUID()}`,
          kind: "bug",
          summary: "Second budget Case",
          repoAlias: record.repoAlias,
          sourceKeyHash: secondSource.key,
        })
        secondary = second.id
        await OrynStore.linkSourceToCase(secondSource.key, second.id)
        await OrynStore.mutateCase(second.id, second.revision, (value) => ({
          ...value,
          createdAt: Date.now() - 61_000,
        }))
        const secondDeadline = Date.now() + 5000
        while ((await OrynStore.getCase(second.id))?.control === "active" && Date.now() < secondDeadline)
          await Bun.sleep(20)
        expect((await OrynStore.getCase(second.id))?.control).toBe("human_owned")
        expect(delivered).toHaveLength(1)
        releaseDelivery.resolve()
        const deliveryDeadline = Date.now() + 5000
        while (delivered.length < 2 && Date.now() < deliveryDeadline) await Bun.sleep(20)
        expect(delivered.map((notice) => notice.sourceKey).sort()).toEqual([source.key, secondSource.key].sort())
        await OrynBudgetRuntime.stop()
        await OrynBudgetRuntime.start()
        await OrynBudgetRuntime.stop()
        expect(delivered).toHaveLength(2)
        expect((await OrynStore.getCase(caseId))?.epoch).toBe(1)
      } finally {
        releaseDelivery.resolve()
        await OrynBudgetRuntime.stop()
        SessionInvoke.cancel(worker.workerSessionId, { recoverQueuedTasks: false })
        await running.catch(() => undefined)
        OrynService.setOutboxDeliverer(undefined)
        await Session.remove(qa.id)
        if (secondary) {
          const record = (await OrynStore.getCase(secondary))!
          await OrynStore.mutateCase(record.id, record.revision, (value) => ({ ...value, control: "closed" }))
        }
      }
    },
    undefined,
    { maxCaseMinutes: 1 },
  )
}, 20_000)

test("budget enforcement cannot overwrite a concurrently completed Attempt", async () => {
  await fixture(
    async ({ caseId, attemptId }) => {
      const record = (await OrynStore.getCase(caseId))!
      await OrynStore.mutateCase(caseId, record.revision, (value) => ({ ...value, createdAt: Date.now() - 61_000 }))
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const reason = OrynBudget.reason
      const held = spyOn(OrynBudget, "reason").mockImplementation(async (record) => {
        const result = await reason(record)
        if (record.id === caseId) {
          entered.resolve()
          await release.promise
        }
        return result
      })
      const pending = OrynControl.enforceBudgets()
      try {
        await entered.promise
        await OrynStore.mutateAttempt(caseId, attemptId, (attempt) => ({ ...attempt, disposition: "ready" }))
        release.resolve()
        expect((await pending).failed).toBe(0)
        expect((await OrynStore.getCase(caseId))?.control).toBe("active")
      } finally {
        release.resolve()
        await pending
        held.mockRestore()
      }
      expect(await OrynBudget.reason((await OrynStore.getCase(caseId))!)).toBeUndefined()
    },
    undefined,
    { maxCaseMinutes: 1 },
  )
})

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

test("startup recovery continues a consumed task without replacing its root", async () => {
  await fixture(async (input) => {
    const initial = await input.dispatch()
    const item = (await SessionInbox.list(initial.workerSessionId))[0]
    await SessionInbox.materializeItem(item)
    await SessionInbox.commitReady(initial.workerSessionId, [item.id])
    await OrynService.recoverWorkers()
    const queued = await SessionInbox.list(initial.workerSessionId)
    expect(queued).toHaveLength(1)
    expect(queued[0].mode).toBe("steer")
    await OrynService.recoverWorkers()
    expect(await SessionInbox.list(initial.workerSessionId)).toHaveLength(1)
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

test("consumed recovery instructions remain bounded across repeated interruptions", async () => {
  await fixture(async (input) => {
    const initial = await input.dispatch()
    const task = (await SessionInbox.list(initial.workerSessionId))[0]
    await SessionInbox.materializeItem(task)
    await SessionInbox.commitReady(initial.workerSessionId, [task.id])
    for (let attempt = 0; attempt < 3; attempt++) {
      await OrynService.recoverWorkers()
      const queued = await SessionInbox.list(initial.workerSessionId)
      expect(queued).toHaveLength(1)
      expect(queued[0].mode).toBe("steer")
      await SessionInbox.materializeItem(queued[0], task.messageID)
      await SessionInbox.commitReady(initial.workerSessionId, [queued[0].id])
    }
    for (const message of await Session.messages({ sessionID: initial.workerSessionId })) {
      if (message.info.role === "user" && message.info.origin?.detail === "oryn_resume")
        await Session.updateMessage({ ...message.info, includeInContext: false })
    }
    await OrynService.recoverWorkers()
    expect((await OrynStore.getCase(input.caseId))?.control).toBe("human_owned")
    expect((await OrynStore.getCase(input.caseId))?.handoff?.reason).toContain("three recovery attempts")
    expect(await SessionInbox.list(initial.workerSessionId)).toHaveLength(0)
    const roots = (await Session.messages({ sessionID: initial.workerSessionId })).filter(
      (m) => m.info.role === "user" && m.info.isRoot,
    )
    expect(roots.map((m) => m.info.id)).toEqual([task.messageID])
    expect(await Session.children(input.rootId)).toHaveLength(1)
  })
})

test("explicit resume restores a consumed worker task after pause", async () => {
  await fixture(async (input) => {
    const initial = await input.dispatch()
    const task = (await SessionInbox.list(initial.workerSessionId))[0]
    await SessionInbox.materializeItem(task)
    await SessionInbox.commitReady(initial.workerSessionId, [task.id])
    const record = (await OrynStore.getCase(input.caseId))!
    const paused = await OrynControl.change({
      caseId: input.caseId,
      expectedRevision: record.revision,
      action: "pause",
    })
    await OrynControl.change({ caseId: input.caseId, expectedRevision: paused.revision, action: "resume" })
    expect((await SessionInbox.list(initial.workerSessionId)).map((item) => item.mode)).toEqual(["steer"])
    expect(await Session.children(input.rootId)).toHaveLength(1)
  })
})

test("engineering recovery resumes its consumed root without launching another Session", async () => {
  await fixture(async (input) => {
    await OrynEngineering.start(input.caseId)
    const task = (await SessionInbox.list(input.rootId))[0]
    expect(task).toBeDefined()
    await SessionInbox.materializeItem(task)
    await SessionInbox.commitReady(input.rootId, [task.id])
    await OrynService.recoverEngineeringTurns({ caseId: input.caseId })
    await OrynService.recoverEngineeringTurns({ caseId: input.caseId })
    expect((await SessionInbox.list(input.rootId)).map((item) => item.mode)).toEqual(["steer"])
    expect((await OrynStore.getCase(input.caseId))?.engineeringSessionId).toBe(input.rootId)
    expect(
      (await Session.messages({ sessionID: input.rootId }))
        .filter((m) => m.info.role === "user" && m.info.isRoot)
        .map((m) => m.info.id),
    ).toEqual([task.messageID])
  })
})

test("a recovered worker completes through the actual scripted model and result tool", async () => {
  let ids: { caseId: string; attemptId: string; assignmentId: string } | undefined
  let reportRequested = false
  await using model = scriptedModel((request) => {
    if (!ids) throw new Error("worker identity is unavailable")
    if (!reportRequested) {
      reportRequested = true
      expect(
        request.messages.some((message) =>
          JSON.stringify(message.content).includes("previous execution was interrupted"),
        ),
      ).toBe(true)
      return {
        tool: "oryn_result",
        input: {
          input: {
            ...ids,
            kind: "repro",
            requestKey: "resumed-result",
            outcome: "needs_human",
            summary: "The saved task was recovered, but its platform is unavailable.",
            limitations: ["Requires the reporter platform"],
          },
        },
      }
    }
    return { text: "Structured result submitted." }
  })
  await fixture(
    async (input) => {
      const initial = await input.dispatch()
      ids = { caseId: input.caseId, attemptId: input.attemptId, assignmentId: initial.assignmentId }
      const task = (await SessionInbox.list(initial.workerSessionId))[0]
      await SessionInbox.materializeItem(task)
      await SessionInbox.commitReady(initial.workerSessionId, [task.id])
      await OrynService.recoverWorkers()
      await SessionManager.wake(initial.workerSessionId)
      const reportID = (await OrynStore.getAssignment(input.caseId, initial.assignmentId))?.acceptedReportId
      expect(model.errors).toEqual([])
      expect(reportID).toBeDefined()
      expect(model.errors).toEqual([])
      expect(model.steps.filter((step) => "tool" in step && step.tool === "oryn_result")).toHaveLength(1)
      await OrynService.recoverWorkers()
      expect(await SessionInbox.list(initial.workerSessionId)).toHaveLength(0)
      const history = await Session.messages({ sessionID: initial.workerSessionId })
      const interrupted = history.find(
        (message) => message.info.role === "assistant" && message.info.error?.name === "MessageAbortedError",
      )
      if (interrupted?.info.role !== "assistant") throw new Error("missing interrupted assistant")
      expect(interrupted.info.path.cwd).toBe((await Session.get(initial.workerSessionId)).workspace!.path)
      expect(history.filter((m) => m.info.role === "user" && m.info.isRoot).map((m) => m.info.id)).toEqual([
        task.messageID,
      ])
      expect(await Session.children(input.rootId)).toHaveLength(1)
    },
    Config.Info.parse({
      model: "oryn-fixture/qa",
      mid_model: "oryn-fixture/qa",
      thinking_model: "oryn-fixture/qa",
      mini_model: "oryn-fixture/qa",
      nano_model: "oryn-fixture/qa",
      enabled_providers: ["oryn-fixture"],
      provider: { "oryn-fixture": model.config },
      embedding: { apiKey: "fixture-only", model: "fixture-embedding", baseURL: model.config.api },
    }),
  )
}, 30000)

test("Host recovery handoff stops a running engineering root before completing", async () => {
  await fixture(async (input) => {
    const entered = Promise.withResolvers<SessionManager.LoopLease>()
    const release = Promise.withResolvers<void>()
    const run = SessionManager.run(input.rootId, async (lease) => {
      entered.resolve(lease)
      await release.promise
    })
    let handoff: Promise<unknown> | undefined
    try {
      const lease = await entered.promise
      let completed = false
      handoff = OrynService.requestHandoff({
        callerSessionID: input.rootId,
        caseId: input.caseId,
        reason: "Recovery budget exhausted",
      }).then((result) => {
        completed = true
        return result
      })
      const deadline = Date.now() + 1000
      while (!lease.signal.aborted && !completed && Date.now() < deadline) await Bun.sleep(10)
      expect(lease.signal.aborted).toBe(true)
      expect(completed).toBe(false)
      release.resolve()
      await handoff
      expect((await OrynStore.getCase(input.caseId))?.control).toBe("human_owned")
    } finally {
      release.resolve()
      await Promise.allSettled([run, ...(handoff ? [handoff] : [])])
    }
  })
}, 10000)

test("engineering recovery continues an unanswered report after an earlier terminal reply", async () => {
  await fixture(async (input) => {
    await OrynEngineering.start(input.caseId)
    const task = (await SessionInbox.list(input.rootId))[0]
    await SessionInbox.materializeItem(task)
    await SessionInbox.commitReady(input.rootId, [task.id])
    await SessionInvoke.repairAfterAbort(input.rootId)
    const reply = (await Session.messages({ sessionID: input.rootId })).findLast((m) => m.info.role === "assistant")!
    if (reply.info.role !== "assistant") throw new Error("missing assistant")
    await Session.updateMessage({ ...reply.info, error: undefined, finish: "stop" })
    await OrynService.recoverEngineeringTurns({ caseId: input.caseId })
    expect(await SessionInbox.list(input.rootId)).toHaveLength(0)
    const report = await SessionInbox.deliverUnique({
      sessionID: input.rootId,
      deliveryKey: "worker-report-fixture",
      mode: "steer",
      message: {
        role: "user",
        origin: { type: "system" },
        parts: [{ type: "text", text: "A worker report is ready for inspection." }],
      },
    })
    const item = (await SessionInbox.list(input.rootId)).find((item) => item.id === report.itemID)!
    await SessionInbox.materializeItem(item, task.messageID)
    await SessionInbox.commitReady(input.rootId, [item.id])
    await OrynService.recoverEngineeringTurns({ caseId: input.caseId })
    expect((await SessionInbox.list(input.rootId)).map((item) => item.mode)).toEqual(["steer"])
  })
})

for (const action of ["takeover", "cancel", "handoff"] as const)
  test(`resume after ${action} creates a fresh Attempt and engineering task while preserving old workers`, async () => {
    await fixture(async ({ rootId, caseId, attemptId, dispatch }) => {
      const previous = await dispatch()
      const oldTask = await SessionInbox.deliverUnique({
        sessionID: rootId,
        deliveryKey: "obsolete-engineering",
        mode: "task",
        message: { role: "user", parts: [{ type: "text", text: "Continue the old attempt" }] },
      })
      const record = (await OrynStore.getCase(caseId))!
      const stopped =
        action === "handoff"
          ? await OrynService.requestHandoff({
              callerSessionID: rootId,
              caseId,
              reason: "Reporter platform requires human inspection",
            })
          : await OrynControl.change({ caseId, expectedRevision: record.revision, action })
      const resumed = await OrynControl.change({ caseId, expectedRevision: stopped.revision, action: "resume" })
      expect(resumed.activeAttemptId).not.toBe(attemptId)
      expect(resumed.engineeringSessionId).toBe(rootId)
      expect((await OrynStore.getAttempt(caseId, attemptId))?.disposition).toBe("superseded")
      expect(await OrynControl.canRun(await Session.get(previous.workerSessionId))).toBe(false)
      const inbox = await SessionInbox.list(rootId)
      expect(inbox.some((item) => item.id === oldTask.itemID)).toBe(false)
      expect(inbox.some((item) => item.deliveryKey === `oryn-ownership:${caseId}:${resumed.epoch}`)).toBe(true)
      const current = await dispatch()
      expect(current.assignmentId).not.toBe(previous.assignmentId)
      expect(current.workerSessionId).not.toBe(previous.workerSessionId)
      expect((await OrynStore.getAssignment(caseId, current.assignmentId))?.epoch).toBe(resumed.epoch)
      expect(await OrynStore.listAttempts(caseId)).toHaveLength(2)
      await OrynService.recoverEngineeringTurns({ caseId })
      expect(await OrynStore.listAttempts(caseId)).toHaveLength(2)
    })
  })

test("ownership task admission stays closed until interrupted Inbox preparation recovers", async () => {
  await fixture(async ({ rootId, caseId, dispatch }) => {
    await dispatch()
    const record = (await OrynStore.getCase(caseId))!
    const stopped = await OrynControl.change({ caseId, expectedRevision: record.revision, action: "takeover" })
    const prepare = spyOn(OrynOwnership, "prepare").mockRejectedValue(new Error("fixture interrupted before Inbox"))
    try {
      await OrynControl.change({ caseId, expectedRevision: stopped.revision, action: "resume" })
    } finally {
      prepare.mockRestore()
    }
    expect(await OrynControl.canRun(await Session.get(rootId))).toBe(false)
    expect((await OrynService.recoverEngineeringTurns({ caseId })).failed).toBe(0)
    const item = (await SessionInbox.list(rootId)).find((item) => item.deliveryKey?.startsWith("oryn-ownership:"))!
    expect(item).toBeDefined()
    expect(await OrynControl.canRun(await Session.get(rootId))).toBe(true)
    await SessionInbox.materializeItem(item)
    await SessionInbox.commitReady(rootId, [item.id])
    await OrynService.recoverEngineeringTurns({ caseId })
    expect(
      (await Session.messages({ sessionID: rootId }))
        .filter((item) => item.info.role === "user" && item.info.isRoot)
        .map((item) => item.info.id),
    ).toEqual([item.messageID])
    expect(await OrynStore.listAttempts(caseId)).toHaveLength(2)
  })
})

test("a persisted human resume recovers after losing the Case pointer write", async () => {
  await fixture(async ({ rootId, caseId, dispatch }) => {
    await dispatch()
    const record = (await OrynStore.getCase(caseId))!
    const stopped = await OrynControl.change({ caseId, expectedRevision: record.revision, action: "cancel" })
    const write = Storage.write
    const fault = spyOn(Storage, "write").mockImplementation(async (key, value) => {
      if (key.join("/") === OrynPath.caseInfo(caseId).join("/")) throw new Error("fixture lost Case update")
      return write(key, value)
    })
    try {
      await expect(
        OrynControl.change({ caseId, expectedRevision: stopped.revision, action: "resume" }),
      ).rejects.toThrow("fixture lost Case update")
    } finally {
      fault.mockRestore()
    }
    const intent = (await OrynStore.ownershipResume(caseId, stopped.epoch))!
    expect((await OrynStore.getCase(caseId))?.control).toBe("cancelled")
    expect((await OrynStore.recoverAttemptTransitions()).failed).toBe(0)
    expect((await OrynStore.getCase(caseId))?.activeAttemptId).toBe(intent.next.id)
    expect(await OrynControl.canRun(await Session.get(rootId))).toBe(false)
    await OrynService.recoverEngineeringTurns({ caseId })
    expect(await OrynControl.canRun(await Session.get(rootId))).toBe(true)
    expect(await OrynStore.listAttempts(caseId)).toHaveLength(2)
  })
})

test("a resumed ownership task dispatches a new worker and consumes its report through the model tools", async () => {
  let caseId = ""
  await using model = scriptedModel((request) => {
    const has = (name: string) => request.tools?.some((item) => item.function.name === name)
    const text = request.messages
      .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
      .join("\n")
    const results = request.messages
      .filter((message) => message.role === "tool")
      .map((message) => JSON.stringify(message.content))
      .join("\n")
    if (has("oryn_dispatch")) {
      expect(text).toContain("Human control resumed Oryn case")
      if (results.includes("control: human_owned")) return { text: "Human handoff recorded" }
      if (results.includes("needs_human"))
        return {
          tool: "oryn_case",
          input: {
            input: {
              action: "request_handoff",
              caseId,
              reason: "Resumed investigation still requires the reporter platform",
            },
          },
        }
      const reportId = /Oryn repro result ([^\s]+) for assignment/.exec(text)?.[1]
      if (reportId) return { tool: "oryn_result", input: { input: { kind: "get", caseId, reportId } } }
      if (!results.includes("assignmentId:"))
        return {
          tool: "oryn_dispatch",
          input: { input: { action: "dispatch", caseId, stage: "repro", requestKey: "repro" } },
        }
      return { text: "Waiting for the current worker result" }
    }
    if (has("oryn_check")) {
      if (results.includes("reportId:")) return { text: "Current result submitted" }
      const attemptId = /Attempt: ([^\s]+)/.exec(text)?.[1]
      const assignmentId = /Oryn assignment ([^\s]+)/.exec(text)?.[1]
      if (!attemptId || !assignmentId) throw new Error("Missing current worker identity")
      return {
        tool: "oryn_result",
        input: {
          input: {
            kind: "repro",
            caseId,
            attemptId,
            assignmentId,
            requestKey: "current-result",
            outcome: "needs_human",
            summary: "Reporter platform remains unavailable",
            limitations: ["Requires the reporter platform"],
          },
        },
      }
    }
    return { text: "Fixture summary" }
  }, 48)
  await fixture(
    async (input) => {
      caseId = input.caseId
      const previous = await input.dispatch()
      const record = (await OrynStore.getCase(caseId))!
      const stopped = await OrynControl.change({ caseId, expectedRevision: record.revision, action: "takeover" })
      const resumed = await OrynControl.change({ caseId, expectedRevision: stopped.revision, action: "resume" })
      await SessionManager.wake(input.rootId)
      const current = (await OrynStore.listAssignments(caseId)).find((item) => item.epoch === resumed.epoch)!
      expect(current).toBeDefined()
      expect(current.id).not.toBe(previous.assignmentId)
      await SessionManager.wake(current.sessionId!)
      await SessionManager.wake(input.rootId)
      expect(model.errors).toEqual([])
      expect((await OrynStore.getAssignment(caseId, current.id))?.acceptedReportId).toBeDefined()
      expect((await OrynStore.getAssignment(caseId, previous.assignmentId))?.acceptedReportId).toBeUndefined()
      expect((await OrynStore.getCase(caseId))?.handoff?.reason).toBe(
        "Resumed investigation still requires the reporter platform",
      )
      expect(model.steps.some((step) => "tool" in step && step.tool === "oryn_dispatch")).toBe(true)
    },
    Config.Info.parse({
      model: "oryn-fixture/qa",
      mid_model: "oryn-fixture/qa",
      thinking_model: "oryn-fixture/qa",
      mini_model: "oryn-fixture/qa",
      nano_model: "oryn-fixture/qa",
      enabled_providers: ["oryn-fixture"],
      provider: { "oryn-fixture": model.config },
      embedding: { apiKey: "fixture-only", model: "fixture-embedding", baseURL: model.config.api },
    }),
  )
}, 60000)
