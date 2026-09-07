import { describe, expect, test } from "bun:test"
import { BossService } from "../../src/boss/boss"
import { BossContinuationPolicy } from "../../src/boss/boss-continuation"
import { registerOrynDomain } from "../../src/oryn/register"
import { OrynService } from "../../src/oryn/service"
import { OrynStore } from "../../src/oryn/store"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { SessionManager } from "../../src/session/manager"
import { tmpdir } from "./fixture"

async function fixture(
  fn: (input: {
    caseId: string
    attemptId: string
    assignmentId: string
    rootId: string
    workerId: string
  }) => Promise<void>,
) {
  await using tmp = await tmpdir({
    git: true,
    config: {
      oryn: {
        enabled: true,
        routes: [{ feishuAccount: "test", repoAlias: "test/repo" }],
        repositories: { "test/repo": { owner: "test", repo: "repo" } },
      },
    },
  })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  await ScopeContext.provide({
    scope,
    fn: async () => {
      const identity = { provider: "feishu" as const, accountId: "test", chatId: tmp.path }
      const { claim } = await OrynStore.claimSource({ identity, requestKey: "handoff" })
      await OrynStore.createCase({
        caseId: claim.caseId,
        kind: "bug",
        summary: "handoff",
        repoAlias: "test/repo",
        sourceKeyHash: claim.sourceKey,
      })
      const root = await OrynService.openEngineeringSession({
        caseId: claim.caseId,
        identity,
        baselineSha: (await Bun.$`git rev-parse HEAD`.cwd(tmp.path).text()).trim(),
      })
      const worker = await BossService.spawn(root.sessionID, { role: "repro", agent: "oryn-repro" })
      await OrynStore.bindSessionSource({ sessionID: worker.id, caseId: claim.caseId, role: "worker", identity })
      const assignment = await OrynStore.createAssignment({
        caseId: claim.caseId,
        attemptId: root.attemptId,
        stage: "repro",
        agentId: "oryn-repro",
        frozenInputsDigest: "fixture",
        epoch: 0,
        sessionId: worker.id,
        requestKey: "dispatch",
      })
      const leases = [SessionManager.acquire(root.sessionID), SessionManager.acquire(worker.id)]
      if (leases.some((lease) => !lease)) throw new Error("fixture session already running")
      try {
        await fn({
          caseId: claim.caseId,
          attemptId: root.attemptId,
          assignmentId: assignment.id,
          rootId: root.sessionID,
          workerId: worker.id,
        })
      } finally {
        for (const id of [worker.id, root.sessionID]) await SessionInbox.removeByMode(id, ["task", "steer", "context"])
        for (const lease of leases) if (lease) await SessionManager.release(lease, { requestNextWork: false })
        await Session.remove(root.sessionID)
      }
    },
  })
}

function result(input: { caseId: string; attemptId: string; assignmentId: string; workerId: string }) {
  return {
    callerSessionID: input.workerId,
    caseId: input.caseId,
    attemptId: input.attemptId,
    assignmentId: input.assignmentId,
    requestKey: "result",
    kind: "repro" as const,
    outcome: "inconclusive",
    summary: "The target environment is unavailable",
  }
}

describe("Oryn worker handoff", () => {
  test("an archived reproduction cannot admit coding", async () => {
    await fixture(async (input) => {
      const record = (await OrynStore.getCase(input.caseId))!
      await OrynStore.mutateCase(input.caseId, record.revision, (value) => ({ ...value, control: "paused" }))
      expect((await OrynService.submitResult({ ...result(input), outcome: "reproduced" })).accepted).toBe(false)
      const paused = (await OrynStore.getCase(input.caseId))!
      await OrynStore.mutateCase(input.caseId, paused.revision, (value) => ({ ...value, control: "active" }))
      await expect(
        OrynService.dispatch({
          callerSessionID: input.rootId,
          caseId: input.caseId,
          stage: "code",
          requestKey: "archived",
        }),
      ).rejects.toThrow()
    })
  })

  test("already-fixed observations do not admit another coding task", async () => {
    await fixture(async (input) => {
      expect((await OrynService.submitResult({ ...result(input), outcome: "already_fixed" })).accepted).toBe(true)
      await expect(
        OrynService.dispatch({
          callerSessionID: input.rootId,
          caseId: input.caseId,
          stage: "code",
          requestKey: "already-fixed",
        }),
      ).rejects.toThrow()
    })
  })

  test("one Attempt cannot dispatch two independent code writers", async () => {
    await fixture(async (input) => {
      await OrynService.submitResult({ ...result(input), outcome: "reproduced" })
      const first = await OrynService.dispatch({
        callerSessionID: input.rootId,
        caseId: input.caseId,
        stage: "code",
        requestKey: "first-writer",
      })
      await expect(
        OrynService.dispatch({
          callerSessionID: input.rootId,
          caseId: input.caseId,
          stage: "code",
          requestKey: "second-writer",
        }),
      ).rejects.toThrow()
      expect(
        await OrynService.dispatch({
          callerSessionID: input.rootId,
          caseId: input.caseId,
          stage: "code",
          requestKey: "first-writer",
        }),
      ).toMatchObject({ assignmentId: first.assignmentId, workerSessionId: first.workerSessionId, deduped: true })
    })
  })

  test("ready attempts cannot receive another dispatch", async () => {
    await fixture(async (input) => {
      await OrynStore.mutateAttempt(input.caseId, input.attemptId, (attempt) => ({ ...attempt, disposition: "ready" }))
      await expect(
        OrynService.dispatch({
          callerSessionID: input.rootId,
          caseId: input.caseId,
          stage: "repro",
          requestKey: "dispatch",
        }),
      ).rejects.toThrow()
      expect(await SessionInbox.list(input.workerId)).toHaveLength(0)
    })
  })

  test("resuming after takeover cannot replay an assignment from the old epoch", async () => {
    await fixture(async (input) => {
      const record = await OrynStore.getCase(input.caseId)
      const taken = await OrynStore.control(input.caseId, record!.revision, "takeover")
      await OrynStore.control(input.caseId, taken.revision, "resume")
      await expect(
        OrynService.dispatch({
          callerSessionID: input.rootId,
          caseId: input.caseId,
          stage: "repro",
          requestKey: "dispatch",
        }),
      ).rejects.toThrow()
      expect(await SessionInbox.list(input.workerId)).toHaveLength(0)
    })
  })

  test("structured report completion stops Boss from nudging the same worker again", async () => {
    registerOrynDomain()
    await fixture(async (input) => {
      await OrynService.dispatch({
        callerSessionID: input.rootId,
        caseId: input.caseId,
        stage: "repro",
        requestKey: "dispatch",
      })
      const item = (await SessionInbox.list(input.workerId))[0]
      await SessionInbox.materializeItem(item)
      await SessionInbox.commitReady(input.workerId, [item.id])
      const session = await Session.get(input.workerId)
      const gate = { session, scopeID: session.scope.id, sessionID: session.id, terminalMessageID: "unused" }
      expect((await BossContinuationPolicy.handle(gate))?.kind).toBe("inbox")
      await OrynService.submitResult(result(input))
      expect(await BossContinuationPolicy.handle(gate)).toBeUndefined()
    })
  })

  test("replayed dispatch repairs missing Boss assignment delivery", async () => {
    await fixture(async (input) => {
      const request = {
        callerSessionID: input.rootId,
        caseId: input.caseId,
        stage: "repro" as const,
        requestKey: "dispatch",
      }
      const replay = await OrynService.dispatch(request)
      expect(replay.workerSessionId).toBe(input.workerId)
      const items = await SessionInbox.list(input.workerId)
      expect(items).toHaveLength(1)
      expect(items[0].deliveryKey).toBe(`oryn:${input.assignmentId}`)
      expect(items[0].message?.metadata?.boss).toMatchObject({ taskID: input.assignmentId })
      expect(JSON.stringify(items[0].message)).toContain(`Attempt: ${input.attemptId}`)
      await OrynService.dispatch(request)
      expect(await SessionInbox.list(input.workerId)).toHaveLength(1)
    })
  })

  test("accepted result wakes the root once without a second model report", async () => {
    await fixture(async (input) => {
      const reports = await Promise.all([
        OrynService.submitResult(result(input)),
        OrynService.submitResult(result(input)),
      ])
      expect(reports[0]).toEqual(reports[1])
      expect(reports[0].accepted).toBe(true)
      expect(await OrynStore.listWorkerReports(input.caseId)).toHaveLength(1)
      const items = await SessionInbox.list(input.rootId)
      expect(items).toHaveLength(1)
      expect(items[0].mode).toBe("steer")
      expect(items[0].message?.metadata?.orynReportId).toBe(reports[0].reportId)
      expect(items[0].message?.metadata?.channelReply).toBeUndefined()
    })
  })

  test("a task delivered before the Boss handoff upgrade is not dispatched again", async () => {
    await fixture(async (input) => {
      const old = await SessionInbox.deliverUnique({
        sessionID: input.workerId,
        deliveryKey: `oryn:${input.assignmentId}`,
        mode: "task",
        message: { role: "user", parts: [{ type: "text", text: "Previously assigned task" }] },
      })
      const item = (await SessionInbox.list(input.workerId)).find((entry) => entry.id === old.itemID)
      expect(item).toBeDefined()
      await SessionInbox.materializeItem(item!)
      await SessionInbox.remove({ sessionID: input.workerId, itemID: item!.id })
      await OrynService.dispatch({
        callerSessionID: input.rootId,
        caseId: input.caseId,
        stage: "repro",
        requestKey: "dispatch",
      })
      expect(await SessionInbox.list(input.workerId)).toHaveLength(0)
    })
  })

  test("replaying a durable accepted report repairs a missing result notification", async () => {
    await fixture(async (input) => {
      const { callerSessionID: _caller, ...payload } = result(input)
      const report = await OrynStore.writeWorkerReport({ ...payload, epoch: 0 })
      await OrynStore.acceptAssignmentReport(input.caseId, input.assignmentId, report.id)
      expect(await SessionInbox.list(input.rootId)).toHaveLength(0)
      const replay = await OrynService.submitResult(result(input))
      expect(replay.reportId).toBe(report.id)
      const item = (await SessionInbox.list(input.rootId))[0]
      expect(item.message?.metadata?.orynReportId).toBe(report.id)
      await SessionInbox.materializeItem(item)
      await SessionInbox.remove({ sessionID: input.rootId, itemID: item.id })
      await OrynService.submitResult(result(input))
      expect(await SessionInbox.list(input.rootId)).toHaveLength(0)
    })
  })

  test("a result request key cannot replace an already accepted payload", async () => {
    await fixture(async (input) => {
      const original = await OrynService.submitResult(result(input))
      await expect(OrynService.submitResult({ ...result(input), summary: "changed claim" })).rejects.toThrow()
      expect(await OrynStore.listWorkerReports(input.caseId)).toHaveLength(1)
      expect((await OrynStore.getAssignment(input.caseId, input.assignmentId))?.acceptedReportId).toBe(
        original.reportId,
      )
    })
  })

  test("a repro worker cannot freeze a candidate by changing its report kind", async () => {
    await fixture(async (input) => {
      await expect(
        OrynService.submitResult({
          ...result(input),
          kind: "candidate",
          outcome: "candidate_ready",
          candidateSha: "forged",
        }),
      ).rejects.toThrow()
      expect((await OrynStore.getAttempt(input.caseId, input.attemptId))?.candidateSha).toBeUndefined()
      expect(await OrynStore.listWorkerReports(input.caseId)).toHaveLength(0)
      expect(await SessionInbox.list(input.rootId)).toHaveLength(0)
    })
  })

  test("paused cases archive reports without accepting or waking engineering", async () => {
    await fixture(async (input) => {
      const record = await OrynStore.getCase(input.caseId)
      await OrynStore.control(input.caseId, record!.revision, "pause")
      const report = await OrynService.submitResult(result(input))
      expect(report).toMatchObject({ accepted: false, stale: true })
      expect((await OrynStore.getAssignment(input.caseId, input.assignmentId))?.acceptedReportId).toBeUndefined()
      expect(await SessionInbox.list(input.rootId)).toHaveLength(0)
    })
  })
})
