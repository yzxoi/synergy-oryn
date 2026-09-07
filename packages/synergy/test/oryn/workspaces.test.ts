import { describe, expect, test } from "bun:test"
import { OrynService } from "../../src/oryn/service"
import { OrynStore } from "../../src/oryn/store"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { SessionManager } from "../../src/session/manager"
import { tmpdir } from "./fixture"

async function commit(directory: string, value: string) {
  await Bun.write(`${directory}/behavior.txt`, value)
  await Bun.$`git add behavior.txt`.cwd(directory).quiet()
  await Bun.$`git -c core.hooksPath=/dev/null commit --no-gpg-sign -m fixture`.cwd(directory).quiet()
  return (await Bun.$`git rev-parse HEAD`.cwd(directory).text()).trim()
}

async function fixture(
  fn: (input: {
    caseId: string
    attemptId: string
    rootId: string
    directory: string
    baseline: string
  }) => Promise<void>,
) {
  await using repo = await tmpdir({
    git: true,
    config: {
      oryn: {
        enabled: true,
        routes: [{ feishuAccount: "test", repoAlias: "repo" }],
        repositories: { repo: { owner: "test", repo: "repo" } },
        executionProfiles: { fixture: { commandAllowlist: ["bun"], timeoutSeconds: 10 } },
      },
    },
  })
  const baseline = await commit(repo.path, "baseline")
  const create = Session.create
  const ids: string[] = []
  const leases: NonNullable<ReturnType<typeof SessionManager.acquire>>[] = []
  try {
    Session.create = async (input) => {
      const session = await create(input)
      ids.push(session.id)
      const lease = SessionManager.acquire(session.id)
      if (!lease) throw new Error("fixture session busy")
      leases.push(lease)
      return session
    }
    await ScopeContext.provide({
      scope: await repo.scope(),
      fn: async () => {
        const identity = { provider: "feishu" as const, accountId: "test", chatId: repo.path }
        const { claim } = await OrynStore.claimSource({ identity, requestKey: "workspace" })
        await OrynStore.createCase({
          caseId: claim.caseId,
          kind: "bug",
          summary: "workspace versions",
          repoAlias: "repo",
          sourceKeyHash: claim.sourceKey,
        })
        const root = await OrynService.openEngineeringSession({ caseId: claim.caseId, identity, baselineSha: baseline })
        await fn({
          caseId: claim.caseId,
          attemptId: root.attemptId,
          rootId: root.sessionID,
          directory: repo.path,
          baseline,
        })
      },
    })
  } finally {
    Session.create = create
    for (const id of ids) await SessionInbox.removeByMode(id, ["task", "steer", "context"])
    for (const lease of leases) await SessionManager.release(lease, { requestNextWork: false })
    for (const id of ids.reverse()) await Session.remove(id)
  }
}

async function run(
  input: { caseId: string; attemptId: string },
  worker: { workerSessionId: string; assignmentId: string },
  lane: "baseline" | "candidate",
) {
  const plan = await OrynService.proposeCheck({
    callerSessionID: worker.workerSessionId,
    caseId: input.caseId,
    attemptId: input.attemptId,
    assignmentId: worker.assignmentId,
    scenario: "read assigned version",
    profileId: "fixture",
    argv: [["bun", "-e", "console.log(await Bun.file('behavior.txt').text())"]],
    checks: ["assigned source version"],
  })
  const result = await OrynService.runCheck({
    callerSessionID: worker.workerSessionId,
    caseId: input.caseId,
    attemptId: input.attemptId,
    assignmentId: worker.assignmentId,
    planId: plan.planId,
    lane,
    abort: new AbortController().signal,
  })
  return (await OrynStore.getRun(input.caseId, result.runId))!
}

describe("Oryn per-assignment workspaces", () => {
  test("oversized process output cannot become successful delivery evidence", async () => {
    await fixture(async (input) => {
      const worker = await OrynService.dispatch({
        callerSessionID: input.rootId,
        caseId: input.caseId,
        attemptId: input.attemptId,
        stage: "repro",
        requestKey: "bounded-output",
      })
      const plan = await OrynService.proposeCheck({
        callerSessionID: worker.workerSessionId,
        caseId: input.caseId,
        attemptId: input.attemptId,
        assignmentId: worker.assignmentId,
        scenario: "bounded output",
        profileId: "fixture",
        argv: [
          [
            "bun",
            "-e",
            "import {writeSync} from 'node:fs';const b=Buffer.alloc(65536,120);for(let i=0;i<32;i++){writeSync(1,b);writeSync(2,b)}",
          ],
        ],
        checks: ["output remains bounded"],
      })
      const result = await OrynService.runCheck({
        callerSessionID: worker.workerSessionId,
        caseId: input.caseId,
        attemptId: input.attemptId,
        assignmentId: worker.assignmentId,
        planId: plan.planId,
        lane: "baseline",
        abort: new AbortController().signal,
      })
      const receipt = await OrynStore.getRun(input.caseId, result.runId)
      expect(result.outcome).toBe("inconclusive")
      expect(receipt?.infrastructureFailure).toBe(true)
      expect(receipt?.observations).toContain("process output truncated; evidence is inconclusive")
    })
  })

  test("reproduction reads the fixed baseline after the engineering checkout moves", async () => {
    await fixture(async (input) => {
      await commit(input.directory, "moving main")
      const repro = await OrynService.dispatch({
        callerSessionID: input.rootId,
        caseId: input.caseId,
        stage: "repro",
        requestKey: "repro",
      })
      const worker = await Session.get(repro.workerSessionId)
      expect(worker.workspace?.type).toBe("git_worktree")
      expect(worker.workspace?.path).not.toBe(input.directory)
      expect((await OrynStore.getAssignment(input.caseId, repro.assignmentId))?.workspaceRef).toBe(
        worker.workspace?.path,
      )
      const receipt = await run(input, repro, "baseline")
      expect(receipt.actualSha).toBe(input.baseline)
      expect(receipt.observations.join("\n")).toContain("baseline")
      expect(receipt.observations.join("\n")).not.toContain("moving main")
    })
  })

  test("a reproduction workspace cannot label its baseline run as candidate evidence", async () => {
    await fixture(async (input) => {
      const repro = await OrynService.dispatch({
        callerSessionID: input.rootId,
        caseId: input.caseId,
        stage: "repro",
        requestKey: "repro",
      })
      await expect(run(input, repro, "candidate")).rejects.toThrow()
      const worker = await Session.get(repro.workerSessionId)
      await Bun.write(`${worker.workspace!.path}/dirty.txt`, "dirty")
      await expect(run(input, repro, "baseline")).rejects.toThrow()
    })
  })

  test("a check that changes source files cannot produce passing evidence", async () => {
    await fixture(async (input) => {
      const repro = await OrynService.dispatch({
        callerSessionID: input.rootId,
        caseId: input.caseId,
        stage: "repro",
        requestKey: "repro",
      })
      const plan = await OrynService.proposeCheck({
        callerSessionID: repro.workerSessionId,
        caseId: input.caseId,
        attemptId: input.attemptId,
        assignmentId: repro.assignmentId,
        scenario: "mutated source",
        profileId: "fixture",
        argv: [["bun", "-e", "await Bun.write('behavior.txt', 'changed')"]],
        checks: ["source mutation must invalidate evidence"],
      })
      const result = await OrynService.runCheck({
        callerSessionID: repro.workerSessionId,
        caseId: input.caseId,
        attemptId: input.attemptId,
        assignmentId: repro.assignmentId,
        planId: plan.planId,
        lane: "baseline",
        abort: new AbortController().signal,
      })
      expect(result.outcome).toBe("inconclusive")
      const receipt = await OrynStore.getRun(input.caseId, result.runId)
      expect(receipt?.observations.join("\n")).toContain("changed")
      expect(receipt?.actualSha).toBe(input.baseline)
    })
  })

  test("paused work and an already-aborted request cannot start checks", async () => {
    await fixture(async (input) => {
      const repro = await OrynService.dispatch({
        callerSessionID: input.rootId,
        caseId: input.caseId,
        stage: "repro",
        requestKey: "repro",
      })
      const worker = await Session.get(repro.workerSessionId)
      const plan = await OrynService.proposeCheck({
        callerSessionID: repro.workerSessionId,
        caseId: input.caseId,
        attemptId: input.attemptId,
        assignmentId: repro.assignmentId,
        scenario: "must not start",
        profileId: "fixture",
        argv: [["bun", "-e", "await Bun.write('started.txt', 'started')"]],
        checks: ["no side effect after cancellation"],
      })
      const request = {
        callerSessionID: repro.workerSessionId,
        caseId: input.caseId,
        attemptId: input.attemptId,
        assignmentId: repro.assignmentId,
        planId: plan.planId,
        lane: "baseline" as const,
      }
      await expect(OrynService.runCheck({ ...request, abort: AbortSignal.abort() })).rejects.toThrow()
      const record = (await OrynStore.getCase(input.caseId))!
      await OrynStore.mutateCase(input.caseId, record.revision, (value) => ({ ...value, control: "paused" }))
      await expect(OrynService.runCheck({ ...request, abort: new AbortController().signal })).rejects.toThrow()
      expect(await Bun.file(`${worker.workspace!.path}/started.txt`).exists()).toBe(false)
    })
  })

  test("verify and review use separate candidate worktrees, independent of author and main", async () => {
    await fixture(async (input) => {
      const repro = await OrynService.dispatch({
        callerSessionID: input.rootId,
        caseId: input.caseId,
        stage: "repro",
        requestKey: "repro",
      })
      await OrynService.submitResult({
        callerSessionID: repro.workerSessionId,
        caseId: input.caseId,
        attemptId: input.attemptId,
        assignmentId: repro.assignmentId,
        requestKey: "repro",
        kind: "repro",
        outcome: "reproduced",
        summary: "fixture stage admission",
      })
      const code = await OrynService.dispatch({
        callerSessionID: input.rootId,
        caseId: input.caseId,
        stage: "code",
        requestKey: "code",
      })
      const author = await Session.get(code.workerSessionId)
      const candidateSha = await commit(author.workspace!.path, "candidate")
      await OrynService.submitResult({
        callerSessionID: code.workerSessionId,
        caseId: input.caseId,
        attemptId: input.attemptId,
        assignmentId: code.assignmentId,
        requestKey: "candidate",
        kind: "candidate",
        outcome: "candidate_ready",
        summary: "fixture candidate",
        candidateSha,
      })
      await commit(input.directory, "unrelated main")
      const verify = await OrynService.dispatch({
        callerSessionID: input.rootId,
        caseId: input.caseId,
        stage: "verify",
        requestKey: "verify",
      })
      const review = await OrynService.dispatch({
        callerSessionID: input.rootId,
        caseId: input.caseId,
        stage: "review",
        requestKey: "review",
      })
      const verifier = await Session.get(verify.workerSessionId)
      const reviewer = await Session.get(review.workerSessionId)
      expect(verifier.workspace?.type).toBe("git_worktree")
      expect(reviewer.workspace?.type).toBe("git_worktree")
      expect(
        new Set([input.directory, author.workspace!.path, verifier.workspace!.path, reviewer.workspace!.path]).size,
      ).toBe(4)
      const receipt = await run(input, verify, "candidate")
      expect(receipt.actualSha).toBe(candidateSha)
      expect(receipt.observations.join("\n")).toContain("candidate")
      expect((await Bun.$`git rev-parse HEAD`.cwd(reviewer.workspace!.path).text()).trim()).toBe(candidateSha)
      await Bun.write(`${verifier.workspace!.path}/experiment.txt`, "local experiment")
      expect(await Bun.file(`${author.workspace!.path}/experiment.txt`).exists()).toBe(false)
      expect(await Bun.file(`${reviewer.workspace!.path}/experiment.txt`).exists()).toBe(false)
    })
  })
})
