import { OrynService } from "../../src/oryn/service"
import { ScopeContext } from "../../src/scope/context"
import { OrynControl } from "../../src/oryn/control"
import { expect, test } from "bun:test"
import { OrynGithub } from "../../src/oryn/github"
import { OrynGithubRuntime, setGithubRuntimeTransport } from "../../src/oryn/github-runtime"
import { OrynGithubStore } from "../../src/oryn/github-store"
import { OrynEngineering } from "../../src/oryn/engineering"
import { OrynStore } from "../../src/oryn/store"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { SessionManager } from "../../src/session/manager"
import { tmpdir, githubConfig } from "./fixture"

test("GitHub review admission creates one real engineering root, invalidates changed heads, and adopts only authorized fix commands", async () => {
  await using repo = await tmpdir({ git: true })
  const repository = `acme/r${crypto.randomUUID()}`
  await Bun.$`git remote add origin ${`https://github.com/${repository}.git`}`.cwd(repo.path).quiet()
  const mergeBaseSha = (await Bun.$`git rev-parse HEAD`.cwd(repo.path).text()).trim()
  await Bun.$`git update-ref refs/remotes/origin/dev HEAD`.cwd(repo.path).quiet()
  await Bun.write(`${repo.path}/widget.ts`, "export const widget = 1\n")
  await Bun.$`git add widget.ts`.cwd(repo.path).quiet()
  await Bun.$`git commit -m "test: widget"`.cwd(repo.path).quiet()
  const headSha = (await Bun.$`git rev-parse HEAD`.cwd(repo.path).text()).trim()
  await Bun.$`git switch --detach ${mergeBaseSha}`.cwd(repo.path).quiet()
  await Bun.write(`${repo.path}/target-only.ts`, "export const target = 1\n")
  await Bun.$`git add target-only.ts`.cwd(repo.path).quiet()
  await Bun.$`git commit -m "test: target advance"`.cwd(repo.path).quiet()
  const baseSha = (await Bun.$`git rev-parse HEAD`.cwd(repo.path).text()).trim()
  await Bun.$`git update-ref refs/remotes/origin/dev HEAD`.cwd(repo.path).quiet()
  await using config = await githubConfig({
    oryn: {
      enabled: true,
      repositories: {
        target: {
          owner: "acme",
          repo: repository.split("/")[1],
          directory: repo.path,
          githubAccount: "app",
          github: { enabled: true },
        },
      },
    },
  })
  let current = {
    number: 20,
    kind: "pull" as const,
    title: "Widget",
    body: "Review me",
    state: "open" as const,
    updatedAt: new Date().toISOString(),
    labels: [],
    comments: [] as Array<{ id: number; body: string; login: string; updatedAt: string; bot: boolean }>,
    headSha,
    baseSha,
  }
  const previous = setGithubRuntimeTransport({
    current: async () => current,
    fetch: async () => {},
    permission: async (_, login) => login === "maintainer",
    findReview: async () => undefined,
    review: async () => {
      throw new Error("no publication expected")
    },
  })
  const create = Session.create
  const roots: string[] = []
  const sessions: string[] = []
  const leases: NonNullable<ReturnType<typeof SessionManager.acquire>>[] = []
  Session.create = async (input) => {
    const session = await create(input)
    if (input?.agentOverride === "oryn-work") {
      expect(await OrynControl.canRun(session)).toBe(false)
      roots.push(session.id)
    }
    sessions.push(session.id)
    leases.push(SessionManager.acquire(session.id)!)
    return session
  }
  try {
    const input = { accountId: "app", repository, repoAlias: "target" }
    const id = (await OrynGithub.accept({ ...input, snapshot: current }))!
    await OrynGithubRuntime.recover()
    const first = (await OrynStore.getCase(id))!
    expect(roots).toHaveLength(1)
    const prepared = (await OrynGithubStore.get(id))!
    await OrynGithubStore.save({ ...prepared, state: "queued", attemptFingerprint: undefined })
    expect(await OrynControl.canRun(await Session.get(roots[0]!))).toBe(false)
    await OrynGithubStore.save(prepared)
    expect(await OrynControl.canRun(await Session.get(roots[0]!))).toBe(true)
    expect((await OrynStore.getAttempt(id, first.activeAttemptId!))?.candidateSha).toBe(headSha)
    expect((await OrynStore.getAttempt(id, first.activeAttemptId!))?.baselineSha).toBe(mergeBaseSha)
    const root = await Session.get(roots[0]!)
    await ScopeContext.provide({
      scope: root.scope,
      workspace: root.workspace,
      fn: async () => {
        const dispatched = await OrynService.dispatch({
          callerSessionID: root.id,
          caseId: id,
          stage: "review",
          reviewDomain: "general",
          requestKey: "diverged-review",
        })
        const worker = await Session.get(dispatched.workerSessionId)
        expect((await Bun.$`git rev-parse HEAD`.cwd(worker.workspace!.path).text()).trim()).toBe(headSha)
        await expect(
          OrynService.dispatch({ callerSessionID: root.id, caseId: id, stage: "code", requestKey: "forbidden" }),
        ).rejects.toBeDefined()
      },
    })

    expect(await SessionInbox.hasRunnableItem(roots[0]!, { allowSteer: true })).toBe(true)
    await OrynGithubRuntime.recover()
    expect(roots).toHaveLength(1)
    current = { ...current, body: "Updated requirements" }
    await OrynGithub.accept({ ...input, snapshot: current })
    await OrynGithubRuntime.recover()
    expect((await OrynStore.getCase(id))?.activeAttemptId).not.toBe(first.activeAttemptId)
    expect((await OrynStore.getAttempt(id, first.activeAttemptId!))?.disposition).toBe("superseded")
    current = {
      ...current,
      comments: [{ id: 1, body: "@oryn fix", login: "outsider", updatedAt: current.updatedAt, bot: false }],
    }
    await OrynGithub.accept({ ...input, snapshot: current })
    await OrynGithubRuntime.recover()
    expect((await OrynGithubStore.get(id))?.repairCaseId).toBeUndefined()
    current = { ...current, comments: [{ ...current.comments[0]!, id: 2, login: "maintainer" }] }
    await OrynGithub.accept({ ...input, snapshot: current })
    await OrynGithubRuntime.recover()
    const repairId = (await OrynGithubStore.get(id))?.repairCaseId
    expect(repairId).toBeDefined()
    expect((await OrynGithubStore.get(repairId!))?.snapshot.headSha).toBe(headSha)
    expect((await OrynStore.getCase(repairId!))?.pullNumbers).toEqual([])
    await OrynGithubRuntime.recover()
    expect(
      (await OrynStore.getAttempt(repairId!, (await OrynStore.getCase(repairId!))!.activeAttemptId!))?.baselineSha,
    ).toBe(headSha)
    const work = (await OrynGithubStore.get(id))!
    await OrynGithubStore.save({ ...work, state: "settled" })
    expect((await OrynEngineering.activeCaseIds()).has(id)).toBe(false)
    const issue = {
      number: 21,
      kind: "issue" as const,
      title: "Feedback",
      body: "Original requirements",
      state: "open" as const,
      updatedAt: current.updatedAt,
      labels: [],
      comments: [],
    }
    const issueId = (await OrynGithub.accept({ ...input, snapshot: issue }))!
    await OrynGithubRuntime.recover()
    const before = (await OrynStore.getCase(issueId))!
    await OrynGithub.accept({ ...input, snapshot: { ...issue, body: "Changed requirements" } })
    expect((await OrynStore.getCase(issueId))!.epoch).toBeGreaterThan(before.epoch)
    await OrynGithubRuntime.recover()
    const after = (await OrynStore.getCase(issueId))!
    expect(after.activeAttemptId).not.toBe(before.activeAttemptId)
    await OrynGithubRuntime.recover()
    expect((await OrynStore.getCase(issueId))?.activeAttemptId).toBe(after.activeAttemptId)
  } finally {
    Session.create = create
    setGithubRuntimeTransport(previous)
    for (const id of sessions) await SessionInbox.removeByMode(id, ["task", "steer", "context"])
    for (const lease of leases) await SessionManager.release(lease, { requestNextWork: false })
    for (const id of sessions.reverse()) await Session.remove(id)
  }
}, 30000)
