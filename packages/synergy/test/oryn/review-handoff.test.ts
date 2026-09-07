import { describe, expect, test } from "bun:test"
import { BossService } from "../../src/boss/boss"
import { OrynService } from "../../src/oryn/service"
import { OrynStore } from "../../src/oryn/store"
import { OrynReports } from "../../src/oryn/reports"
import { OrynCaseTool, OrynResultTool } from "../../src/oryn/tools"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { SessionManager } from "../../src/session/manager"
import { tmpdir } from "../fixture/fixture"
import { externalIdentityHash } from "../../src/util/identity"

async function request(input: { caseId: string; attemptId: string; assignmentId: string; workerId: string }) {
  const sha = (await OrynStore.getAttempt(input.caseId, input.attemptId))!.baselineSha
  return {
    callerSessionID: input.workerId,
    caseId: input.caseId,
    attemptId: input.attemptId,
    assignmentId: input.assignmentId,
    requestKey: "review",
    headSha: sha,
    baseSha: sha,
    findings: [],
    evidenceAssessment: "fixture observations",
    recommendation: "ready_for_human" as const,
  }
}

describe("Oryn structured review handoff", () => {
  test("an unaccepted newer review cannot clear the accepted blocker", async () => {
    await fixture(async (input) => {
      const args = await request(input)
      const result = await OrynService.submitReview({
        ...args,
        recommendation: "changes_required",
        findings: [
          {
            id: "B1",
            severity: "P1",
            category: "correctness",
            trigger: "repeat request",
            impact: "duplicate write",
            evidenceRefs: [],
            disposition: "open",
          },
        ],
      })
      const original = (await OrynStore.getReview(input.caseId, result.reviewId))!
      const { id: _id, schemaVersion: _schema, createdAt: _time, ...payload } = original
      await OrynStore.writeReview({
        ...payload,
        recommendation: "ready_for_human",
        findings: payload.findings.map((finding) => ({ ...finding, disposition: "resolved" })),
      })
      const gate = await OrynService.evaluateDelivery({
        callerSessionID: input.rootId,
        caseId: input.caseId,
        ciStatus: "passed",
        payload: args.headSha,
      })
      expect(gate.failures.some((failure) => failure.message.includes("open blocker"))).toBe(true)
    })
  })
  test("a free-text review note cannot finish a reviewer assignment", async () => {
    await fixture(async (input) => {
      await expect(
        OrynService.submitResult({
          callerSessionID: input.workerId,
          caseId: input.caseId,
          attemptId: input.attemptId,
          assignmentId: input.assignmentId,
          requestKey: "note",
          kind: "review_note",
          outcome: "done",
          summary: "looks fine",
        }),
      ).rejects.toThrow()
      expect((await OrynStore.getAssignment(input.caseId, input.assignmentId))?.acceptedReportId).toBeUndefined()
    })
  })

  test("a newer general review does not hide a security blocker", async () => {
    await fixture(async (input) => {
      const args = await request(input)
      const original = await OrynService.submitReview(args)
      const seed = (await OrynStore.getReview(input.caseId, original.reviewId))!
      const { id: _id, schemaVersion: _schema, createdAt: _time, ...payload } = seed
      for (const domain of ["security", "general"] as const) {
        const assignment = await OrynStore.createAssignment({
          caseId: input.caseId,
          attemptId: input.attemptId,
          stage: "review",
          agentId: "oryn-review",
          reviewDomain: domain,
          sessionId: input.workerId,
          frozenInputsDigest: (await OrynStore.getAssignment(input.caseId, input.assignmentId))!.frozenInputsDigest,
          epoch: 0,
          requestKey: domain,
        })
        const report = await OrynStore.writeReview({
          ...payload,
          assignmentId: assignment.id,
          domain,
          recommendation: domain === "security" ? "changes_required" : "ready_for_human",
          findings:
            domain === "security"
              ? [
                  {
                    id: "S1",
                    severity: "P1",
                    category: "security",
                    trigger: "cross-source request",
                    impact: "private content exposed",
                    evidenceRefs: [],
                    disposition: "open",
                  },
                ]
              : [],
        })
        await OrynStore.acceptAssignmentReport(input.caseId, assignment.id, report.id)
      }
      const gate = await OrynService.evaluateDelivery({
        callerSessionID: input.rootId,
        caseId: input.caseId,
        ciStatus: "passed",
        payload: args.headSha,
      })
      expect(
        gate.failures.some((failure) => failure.message.includes("security") && failure.message.includes("blocker")),
      ).toBe(true)
    })
  })

  test("acceptance changes invalidate a previously accepted review", async () => {
    await fixture(async (input) => {
      const args = await request(input)
      await OrynService.submitReview(args)
      const record = (await OrynStore.getCase(input.caseId))!
      await OrynStore.mutateCase(input.caseId, record.revision, (value) => ({
        ...value,
        acceptanceDigest: "changed acceptance",
      }))
      const gate = await OrynService.evaluateDelivery({
        callerSessionID: input.rootId,
        caseId: input.caseId,
        ciStatus: "passed",
        payload: args.headSha,
      })
      expect(gate.failures.some((failure) => failure.message.includes("review snapshot"))).toBe(true)
    })
  })

  test("a reviewer assigned before an acceptance change cannot certify the replacement", async () => {
    await fixture(async (input) => {
      const record = (await OrynStore.getCase(input.caseId))!
      await OrynStore.mutateCase(input.caseId, record.revision, (value) => ({
        ...value,
        acceptanceDigest: "replacement",
      }))
      expect(await OrynService.submitReview(await request(input))).toMatchObject({ accepted: false, stale: true })
    })
  })
  test("the engineering result tool reads the full structured review", async () => {
    await fixture(async (input) => {
      const submitted = await OrynService.submitReview(await request(input))
      const tool = await OrynResultTool.init()
      const result = await tool.execute(
        { input: { kind: "get", caseId: input.caseId, reportId: submitted.reviewId } },
        {
          sessionID: input.rootId,
          messageID: "fixture",
          agent: "oryn-work",
          abort: new AbortController().signal,
          metadata() {},
          async ask() {},
        },
      )
      expect(JSON.parse(result.output).recommendation).toBe("ready_for_human")
      expect(result.metadata.reportKind).toBe("review")
      const current = await (
        await OrynCaseTool.init()
      ).execute(
        { input: { action: "get", caseId: input.caseId } },
        {
          sessionID: input.rootId,
          messageID: "fixture",
          agent: "oryn-work",
          abort: new AbortController().signal,
          metadata() {},
          async ask() {},
        },
      )
      expect(JSON.parse(current.output).attempt.reviewIds).toContain(submitted.reviewId)
      expect(JSON.parse(current.output).attempt.candidateSha).toBe((await request(input)).headSha)
    })
  })

  test("startup recovery repairs accepted review delivery without another model report", async () => {
    await fixture(async (input) => {
      const deliver = SessionInbox.deliverUnique
      try {
        SessionInbox.deliverUnique = async (message) => {
          if (message.sessionID === input.rootId) throw new Error("injected Inbox failure")
          return deliver(message)
        }
        await expect(OrynService.submitReview(await request(input))).rejects.toThrow("injected")
      } finally {
        SessionInbox.deliverUnique = deliver
      }
      expect((await OrynStore.getAssignment(input.caseId, input.assignmentId))?.acceptedReportId).toBeDefined()
      await OrynReports.recover()
      expect(await SessionInbox.list(input.rootId)).toHaveLength(1)
      await OrynReports.recover()
      expect(await SessionInbox.list(input.rootId)).toHaveLength(1)
    })
  })
  test("concurrent replay yields one review and one root event, including after consumption", async () => {
    await fixture(async (input) => {
      const args = await request(input)
      const [one, two] = await Promise.all([OrynService.submitReview(args), OrynService.submitReview(args)])
      expect(one.reviewId).toBe(two.reviewId)
      expect(one.accepted).toBe(true)
      expect(await OrynStore.listReviews(input.caseId)).toHaveLength(1)
      const inbox = await SessionInbox.list(input.rootId)
      expect(inbox).toHaveLength(1)
      expect(inbox[0].message?.metadata?.orynReportId).toBe(one.reviewId)
      expect(inbox[0].message?.metadata?.channelReply).toBeUndefined()
      await SessionInbox.materializeItem(inbox[0])
      await SessionInbox.commitReady(input.rootId, [inbox[0].id])
      const attempt = await OrynStore.getAttempt(input.caseId, input.attemptId)
      expect(await OrynService.submitReview(args)).toEqual(one)
      expect(await OrynStore.getAttempt(input.caseId, input.attemptId)).toEqual(attempt)
      expect(await SessionInbox.list(input.rootId)).toHaveLength(0)
    })
  })

  test("changed review request content is rejected without appending a report", async () => {
    await fixture(async (input) => {
      const args = await request(input)
      await OrynService.submitReview(args)
      await expect(OrynService.submitReview({ ...args, evidenceAssessment: "different claims" })).rejects.toThrow()
      expect(await OrynStore.listReviews(input.caseId)).toHaveLength(1)
    })
  })

  test("the assignment owns the review domain", async () => {
    await fixture(async (input) => {
      await expect(OrynService.submitReview({ ...(await request(input)), domain: "security" })).rejects.toThrow()
      expect(await OrynStore.listReviews(input.caseId)).toHaveLength(0)
    })
  })

  test("paused cases archive judgments without accepting or waking", async () => {
    await fixture(async (input) => {
      const record = (await OrynStore.getCase(input.caseId))!
      await OrynStore.control(input.caseId, record.revision, "pause")
      const result = await OrynService.submitReview(await request(input))
      expect(result).toMatchObject({ accepted: false, stale: true })
      expect((await OrynStore.getAssignment(input.caseId, input.assignmentId))?.acceptedReportId).toBeUndefined()
      expect(await SessionInbox.list(input.rootId)).toHaveLength(0)
    })
  })

  test("a persisted review is reused after acceptance fails", async () => {
    await fixture(async (input) => {
      const args = await request(input)
      const accept = OrynStore.acceptAssignmentReport
      try {
        OrynStore.acceptAssignmentReport = async () => {
          throw new Error("injected acceptance failure")
        }
        await expect(OrynService.submitReview(args)).rejects.toThrow("injected")
      } finally {
        OrynStore.acceptAssignmentReport = accept
      }
      const before = (await OrynStore.listReviews(input.caseId))[0]
      const result = await OrynService.submitReview(args)
      expect(result.reviewId).toBe(before.id)
      expect(await OrynStore.listReviews(input.caseId)).toHaveLength(1)
      expect(await SessionInbox.list(input.rootId)).toHaveLength(1)
    })
  })
})

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
      await OrynStore.recordSource({ identity })
      await OrynStore.linkSourceToCase(claim.sourceKey, claim.caseId)
      await OrynStore.mutateAttempt(claim.caseId, root.attemptId, (attempt) => ({
        ...attempt,
        candidateSha: attempt.baselineSha,
        disposition: "candidate_frozen",
      }))
      const worker = await BossService.spawn(root.sessionID, { role: "review", agent: "oryn-review" })
      await OrynStore.bindSessionSource({ sessionID: worker.id, caseId: claim.caseId, role: "worker", identity })
      const assignment = await OrynStore.createAssignment({
        caseId: claim.caseId,
        attemptId: root.attemptId,
        stage: "review",
        agentId: "oryn-review",
        frozenInputsDigest: externalIdentityHash(
          (await OrynStore.getAttempt(claim.caseId, root.attemptId))!.baselineSha,
          (await OrynStore.getAttempt(claim.caseId, root.attemptId))!.candidateSha!,
          (await OrynStore.getCase(claim.caseId))!.acceptanceDigest,
          "review",
        ),
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
