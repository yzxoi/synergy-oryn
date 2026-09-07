import { describe, expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { OrynService } from "../../src/oryn/service"
import { OrynStore, sourceKey, storeError } from "../../src/oryn/store"
import { tmpdir } from "../fixture/fixture"

const orynEnabledConfig = {
  oryn: {
    enabled: true,
    routes: [{ feishuAccount: "acc_test", repoAlias: "acme/widget" }],
    repositories: { "acme/widget": { owner: "acme", repo: "widget", baseBranch: "dev" } },
  },
}

const feishuIdentity = (chatId: string) =>
  ({
    provider: "feishu" as const,
    accountId: "acc_test",
    chatId,
    threadId: `thr_${chatId}`,
    messageId: `msg_${chatId}`,
  }) as const

async function withScope<T>(fn: (scope: Scope) => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true, config: orynEnabledConfig })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn: () => fn(scope) })
}

function errorCode(error: unknown): string | undefined {
  return (error as { data?: { code?: string } })?.data?.code
}

async function activeAttemptId(caseId: string): Promise<string> {
  const record = await OrynStore.getCase(caseId)
  if (!record?.activeAttemptId) throw new Error(`no active attempt for ${caseId}`)
  return record.activeAttemptId
}

describe("OrynService case submission", () => {
  test("routes through configured routes and dedups on requestKey", async () => {
    await withScope(async () => {
      const identity = feishuIdentity("chat_route")
      await OrynStore.bindSessionSource({ sessionID: "ses_qa_route", identity, role: "qa" })
      const first = await OrynService.submitCase({
        callerSessionID: "ses_qa_route",
        requestKey: "rk_submit_1",
        kind: "bug",
        summary: "forwarded message shows placeholder",
        expected: "forwarded content arrives",
      })
      expect(first.created).toBe(true)
      expect(first.repoAlias).toBe("acme/widget")
      const replay = await OrynService.submitCase({
        callerSessionID: "ses_qa_route",
        requestKey: "rk_submit_1",
        kind: "bug",
        summary: "forwarded message shows placeholder",
      })
      expect(replay.created).toBe(false)
      expect(replay.caseId).toBe(first.caseId)
      const second = await OrynService.submitCase({
        callerSessionID: "ses_qa_route",
        requestKey: "rk_submit_2",
        kind: "usage",
        summary: "unrelated question",
      })
      expect(second.caseId).not.toBe(first.caseId)
    })
  })

  test("rejects when no route matches the source account", async () => {
    await withScope(async () => {
      await OrynStore.bindSessionSource({
        sessionID: "ses_qa_other",
        identity: { provider: "feishu", accountId: "acc_other", chatId: "chat_x", messageId: "m" },
        role: "qa",
      })
      try {
        await OrynService.submitCase({
          callerSessionID: "ses_qa_other",
          requestKey: "rk_x",
          kind: "bug",
          summary: "unrouted",
        })
        expect.unreachable()
      } catch (error) {
        expect(errorCode(error)).toBe("NOT_AUTHORIZED")
      }
    })
  })

  test("non-QA bindings cannot submit cases", async () => {
    await withScope(async () => {
      await OrynStore.bindSessionSource({
        sessionID: "ses_worker_x",
        identity: feishuIdentity("chat_w"),
        role: "worker",
      })
      try {
        await OrynService.submitCase({
          callerSessionID: "ses_worker_x",
          requestKey: "rk_w",
          kind: "bug",
          summary: "worker cannot file",
        })
        expect.unreachable()
      } catch (error) {
        expect(errorCode(error)).toBe("NOT_AUTHORIZED")
      }
    })
  })
})

describe("OrynService engineering sessions and dispatch", () => {
  async function seeded() {
    const identity = feishuIdentity(`chat_${Math.random().toString(36).slice(2, 8)}`)
    await OrynStore.bindSessionSource({ sessionID: "ses_qa_seed", identity, role: "qa" })
    const submitted = await OrynService.submitCase({
      callerSessionID: "ses_qa_seed",
      requestKey: `rk_${Math.random().toString(36).slice(2, 8)}`,
      kind: "bug",
      summary: "dispatch seed case",
      expected: "fixed behavior",
    })
    const opened = await OrynService.openEngineeringSession({
      caseId: submitted.caseId,
      identity,
      baselineSha: "base0001",
    })
    return { submitted, opened, identity }
  }

  test("engineering session opens once and pins the initial attempt", async () => {
    await withScope(async () => {
      const { submitted, opened } = await seeded()
      expect(opened.sessionID.startsWith("ses_")).toBe(true)
      const again = await OrynService.openEngineeringSession({
        caseId: submitted.caseId,
        identity: feishuIdentity("chat_irrelevant"),
        baselineSha: "base0002",
      })
      expect(again.sessionID).toBe(opened.sessionID)
      expect(again.attemptId).toBe(opened.attemptId)
      const record = await OrynStore.getCase(submitted.caseId)
      expect(record?.engineeringSessionId).toBe(opened.sessionID)
      expect(record?.activeAttemptId).toBe(opened.attemptId)
    })
  })

  test("dispatch repro spawns a bound worker and dedups on requestKey", async () => {
    await withScope(async () => {
      const { submitted, opened } = await seeded()
      const first = await OrynService.dispatch({
        callerSessionID: opened.sessionID,
        caseId: submitted.caseId,
        stage: "repro",
        requestKey: "rk_dispatch_repro",
      })
      expect(first.deduped).toBe(false)
      const binding = await OrynStore.sessionSourceBinding(first.workerSessionId)
      expect(binding?.role).toBe("worker")
      expect(binding?.caseId).toBe(submitted.caseId)
      const repeat = await OrynService.dispatch({
        callerSessionID: opened.sessionID,
        caseId: submitted.caseId,
        stage: "repro",
        requestKey: "rk_dispatch_repro",
      })
      expect(repeat.deduped).toBe(true)
      expect(repeat.workerSessionId).toBe(first.workerSessionId)
    })
  })

  test("code stage is rejected until a reproduction is accepted", async () => {
    await withScope(async () => {
      const { submitted, opened } = await seeded()
      try {
        await OrynService.dispatch({
          callerSessionID: opened.sessionID,
          caseId: submitted.caseId,
          stage: "code",
          requestKey: "rk_code_early",
        })
        expect.unreachable()
      } catch (error) {
        expect(errorCode(error)).toBe("INVALID_STAGE")
      }
    })
  })

  test("non-root sessions cannot dispatch", async () => {
    await withScope(async () => {
      const { submitted, opened } = await seeded()
      await OrynStore.bindSessionSource({
        sessionID: "ses_stranger_eng",
        identity: feishuIdentity("chat_stranger"),
        caseId: submitted.caseId,
        role: "engineering",
      })
      try {
        await OrynService.dispatch({
          callerSessionID: "ses_stranger_eng",
          caseId: submitted.caseId,
          stage: "repro",
          requestKey: "rk_stranger",
        })
        expect.unreachable()
      } catch (error) {
        expect(errorCode(error)).toBe("NOT_AUTHORIZED")
      }
      expect(opened.sessionID.startsWith("ses_")).toBe(true)
    })
  })
})

describe("OrynService worker results", () => {
  async function withReproDispatch() {
    const identity = feishuIdentity(`chat_${Math.random().toString(36).slice(2, 8)}`)
    await OrynStore.bindSessionSource({ sessionID: "ses_qa_res", identity, role: "qa" })
    const submitted = await OrynService.submitCase({
      callerSessionID: "ses_qa_res",
      requestKey: `rk_${Math.random().toString(36).slice(2, 8)}`,
      kind: "bug",
      summary: "result flow case",
    })
    const opened = await OrynService.openEngineeringSession({
      caseId: submitted.caseId,
      identity,
      baselineSha: "base9999",
    })
    const dispatch = await OrynService.dispatch({
      callerSessionID: opened.sessionID,
      caseId: submitted.caseId,
      stage: "repro",
      requestKey: "rk_repro_result",
    })
    return { submitted, opened, dispatch }
  }

  test("worker result is accepted and a foreign session is rejected", async () => {
    await withScope(async () => {
      const { submitted, dispatch } = await withReproDispatch()
      const attemptId = await activeAttemptId(submitted.caseId)
      const assignment = await OrynStore.getAssignment(submitted.caseId, dispatch.assignmentId)
      expect(assignment?.sessionId).toBe(dispatch.workerSessionId)

      const result = await OrynService.submitResult({
        callerSessionID: dispatch.workerSessionId,
        caseId: submitted.caseId,
        attemptId,
        assignmentId: dispatch.assignmentId,
        requestKey: "rk_result_1",
        kind: "repro",
        outcome: "reproduced",
        summary: "baseline assertion failed as reported",
      })
      expect(result.accepted).toBe(true)
      expect(result.stale).toBe(false)

      try {
        await OrynService.submitResult({
          callerSessionID: "ses_not_the_worker",
          caseId: submitted.caseId,
          attemptId,
          assignmentId: dispatch.assignmentId,
          requestKey: "rk_result_2",
          kind: "repro",
          outcome: "reproduced",
          summary: "someone else's report",
        })
        expect.unreachable()
      } catch (error) {
        expect(errorCode(error)).toBe("NOT_AUTHORIZED")
      }
    })
  })

  test("stale-epoch results are archived but not accepted", async () => {
    await withScope(async () => {
      const { submitted, opened, dispatch } = await withReproDispatch()
      const record = await OrynStore.getCase(submitted.caseId)
      await OrynStore.control(submitted.caseId, record!.revision, "takeover")
      const result = await OrynService.submitResult({
        callerSessionID: dispatch.workerSessionId,
        caseId: submitted.caseId,
        attemptId: await activeAttemptId(submitted.caseId),
        assignmentId: dispatch.assignmentId,
        requestKey: "rk_result_stale",
        kind: "repro",
        outcome: "reproduced",
        summary: "arrived after takeover",
      })
      expect(result.stale).toBe(true)
      expect(result.accepted).toBe(false)
      const assignment = await OrynStore.getAssignment(submitted.caseId, dispatch.assignmentId)
      expect(assignment?.acceptedReportId).toBeUndefined()
      expect(opened.sessionID.startsWith("ses_")).toBe(true)
    })
  })

  test("candidate result freezes the attempt candidateSha and unlocks verify", async () => {
    await withScope(async () => {
      const { submitted, opened, dispatch } = await withReproDispatch()
      const attemptId = await activeAttemptId(submitted.caseId)
      await OrynService.submitResult({
        callerSessionID: dispatch.workerSessionId,
        caseId: submitted.caseId,
        attemptId,
        assignmentId: dispatch.assignmentId,
        requestKey: "rk_repro_ok",
        kind: "repro",
        outcome: "reproduced",
        summary: "reproduced on baseline",
      })
      const codeDispatch = await OrynService.dispatch({
        callerSessionID: opened.sessionID,
        caseId: submitted.caseId,
        stage: "code",
        requestKey: "rk_code_after_repro",
      })
      await OrynService.submitResult({
        callerSessionID: codeDispatch.workerSessionId,
        caseId: submitted.caseId,
        attemptId,
        assignmentId: codeDispatch.assignmentId,
        requestKey: "rk_candidate_1",
        kind: "candidate",
        outcome: "candidate_ready",
        summary: "fix applied with regression test",
        candidateSha: "cand1e2e3",
      })
      const attempt = await OrynStore.getAttempt(submitted.caseId, attemptId)
      expect(attempt?.candidateSha).toBe("cand1e2e3")
      expect(attempt?.disposition).toBe("candidate_frozen")

      const verifyDispatch = await OrynService.dispatch({
        callerSessionID: opened.sessionID,
        caseId: submitted.caseId,
        stage: "verify",
        requestKey: "rk_verify_after_freeze",
      })
      expect(verifyDispatch.deduped).toBe(false)
      const verifyBinding = await OrynStore.sessionSourceBinding(verifyDispatch.workerSessionId)
      expect(verifyBinding?.role).toBe("worker")
    })
  })
})

describe("OrynService reply outbox", () => {
  test("replies dedup per kind and drain delivers through the injected deliverer", async () => {
    await withScope(async () => {
      const identity = feishuIdentity("chat_reply")
      await OrynStore.bindSessionSource({ sessionID: "ses_qa_reply", identity, role: "qa" })
      await OrynStore.recordSource({ identity })
      const first = await OrynService.reply({
        callerSessionID: "ses_qa_reply",
        kind: "accepted",
        text: "已记录，正在核实；结果会回复到这里",
      })
      expect(first.created).toBe(true)
      const replay = await OrynService.reply({
        callerSessionID: "ses_qa_reply",
        kind: "accepted",
        text: "重复通知",
      })
      expect(replay.created).toBe(false)
      expect(replay.entryId).toBe(first.entryId)

      const delivered: string[] = []
      OrynService.setOutboxDeliverer(async (input) => {
        delivered.push(`${input.kind}:${input.identity.chatId}`)
      })
      const drained = await OrynService.drainOutbox()
      expect(drained.delivered).toBeGreaterThanOrEqual(1)
      expect(delivered).toContain("accepted:chat_reply")
      const pending = await OrynStore.listPendingOutbox()
      expect(pending.find((e) => e.id === first.entryId)).toBeUndefined()
    })
  })
})
