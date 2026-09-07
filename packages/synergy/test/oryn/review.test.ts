import { describe, expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { OrynService } from "../../src/oryn/service"
import { OrynStore } from "../../src/oryn/store"
import { tmpdir } from "../fixture/fixture"

function errorCode(error: unknown): string | undefined {
  return (error as { data?: { code?: string } })?.data?.code
}

const feishuIdentity = (chatId: string) =>
  ({
    provider: "feishu" as const,
    accountId: "acc_test",
    chatId,
    threadId: `thr_${chatId}`,
    messageId: `msg_${chatId}`,
  }) as const

async function withRevScope<T>(
  review: { maxRepairRounds?: number; maxNoProgressRounds?: number },
  fn: (root: string) => Promise<T>,
): Promise<T> {
  await using tmp = await tmpdir({
    git: true,
    config: {
      oryn: {
        enabled: true,
        routes: [{ feishuAccount: "acc_test", repoAlias: "acme/widget" }],
        repositories: { "acme/widget": { owner: "acme", repo: "widget", baseBranch: "dev" } },
        executionProfiles: {
          quick: { commandAllowlist: ["echo", "bun"], timeoutSeconds: 60, maxConcurrent: 1 },
        },
        review,
      },
    },
  })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn: () => fn(tmp.path) })
}

async function headSha(root: string): Promise<string> {
  return Bun.$`git rev-parse HEAD`
    .cwd(root)
    .text()
    .then((s) => s.trim())
}

async function activeAttemptId(caseId: string): Promise<string> {
  const record = await OrynStore.getCase(caseId)
  if (!record?.activeAttemptId) throw new Error(`no active attempt for ${caseId}`)
  return record.activeAttemptId
}

const finding = (id: string, severity: "P0" | "P1", disposition: "open" | "resolved" | "still_open") => ({
  id,
  severity,
  category: "correctness",
  trigger: "reproducible trigger",
  impact: "user-visible impact",
  evidenceRefs: [],
  disposition,
})

type Frozen = {
  caseId: string
  engineeringSessionId: string
  attemptId: string
  baselineSha: string
  candidateSha: string
}

/** Case → engineering root → failing baseline run → repro → code → frozen candidate. */
async function seedFrozen(root: string): Promise<Frozen> {
  const identity = feishuIdentity(`chat_${Math.random().toString(36).slice(2, 8)}`)
  await OrynStore.bindSessionSource({ sessionID: "ses_qa_rev", identity, role: "qa" })
  const submitted = await OrynService.submitCase({
    callerSessionID: "ses_qa_rev",
    requestKey: `rk_${Math.random().toString(36).slice(2, 8)}`,
    kind: "bug",
    summary: "review pipeline case",
    expected: "fixed behavior",
  })
  const caseId = submitted.caseId
  const opened = await OrynService.openEngineeringSession({
    caseId,
    identity,
    baselineSha: await headSha(root),
  })
  const attemptId = await activeAttemptId(caseId)
  const baselineSha = (await OrynStore.getAttempt(caseId, attemptId))!.baselineSha

  const repro = await OrynService.dispatch({
    callerSessionID: opened.sessionID,
    caseId,
    stage: "repro",
    requestKey: "rk_repro_seed",
  })
  const baselinePlan = await OrynService.proposeCheck({
    callerSessionID: repro.workerSessionId,
    caseId,
    attemptId,
    assignmentId: repro.assignmentId,
    scenario: "baseline fails as reported",
    profileId: "quick",
    argv: [["bun", "--print", "process.exit(1)"]],
    checks: ["baseline assertion"],
  })
  const baselineRun = await OrynService.runCheck({
    callerSessionID: repro.workerSessionId,
    caseId,
    attemptId,
    assignmentId: repro.assignmentId,
    planId: baselinePlan.planId,
    lane: "baseline",
    abort: new AbortController().signal,
  })
  expect(baselineRun.outcome).toBe("failed")

  await OrynService.submitResult({
    callerSessionID: repro.workerSessionId,
    caseId,
    attemptId,
    assignmentId: repro.assignmentId,
    requestKey: "rk_repro_result",
    kind: "repro",
    outcome: "reproduced",
    summary: "baseline assertion failed",
    runIds: [baselineRun.runId],
  })

  const code = await OrynService.dispatch({
    callerSessionID: opened.sessionID,
    caseId,
    stage: "code",
    requestKey: "rk_code_seed",
  })
  const candidateSha = await headSha(root)
  await OrynService.submitResult({
    callerSessionID: code.workerSessionId,
    caseId,
    attemptId,
    assignmentId: code.assignmentId,
    requestKey: "rk_candidate_seed",
    kind: "candidate",
    outcome: "candidate_ready",
    summary: "fix with regression test",
    candidateSha,
  })

  return { caseId, engineeringSessionId: opened.sessionID, attemptId, baselineSha, candidateSha }
}

/** Freeze a new candidate on the current active attempt (post-rework). */
async function freezeOnActive(root: string, seeded: Frozen, requestKey: string): Promise<string> {
  const code = await OrynService.dispatch({
    callerSessionID: seeded.engineeringSessionId,
    caseId: seeded.caseId,
    stage: "code",
    requestKey,
  })
  const candidateSha = await headSha(root)
  await OrynService.submitResult({
    callerSessionID: code.workerSessionId,
    caseId: seeded.caseId,
    attemptId: await activeAttemptId(seeded.caseId),
    assignmentId: code.assignmentId,
    requestKey: `${requestKey}_result`,
    kind: "candidate",
    outcome: "candidate_ready",
    summary: "reworked candidate",
    candidateSha,
  })
  return candidateSha
}

describe("OrynService review intake", () => {
  test("pins reviews to the frozen candidate and enforces prior-finding continuity", async () => {
    await withRevScope({}, async (root) => {
      const seeded = await seedFrozen(root)

      const review = await OrynService.dispatch({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        stage: "review",
        requestKey: "rk_review_1",
      })

      // Only the review assignment's session may submit.
      try {
        await OrynService.submitReview({
          callerSessionID: seeded.engineeringSessionId,
          caseId: seeded.caseId,
          attemptId: seeded.attemptId,
          assignmentId: review.assignmentId,
          requestKey: "rk_review_submit_role",
          headSha: seeded.candidateSha,
          baseSha: seeded.baselineSha,
          findings: [],
          evidenceAssessment: "engineering root cannot review its own work",
          recommendation: "changes_required",
        })
        expect.unreachable()
      } catch (error) {
        expect(errorCode(error)).toBe("NOT_AUTHORIZED")
      }

      // Head must be the frozen candidate.
      try {
        await OrynService.submitReview({
          callerSessionID: review.workerSessionId,
          caseId: seeded.caseId,
          attemptId: seeded.attemptId,
          assignmentId: review.assignmentId,
          requestKey: "rk_review_submit_wronghead",
          headSha: "0000000000000000000000000000000000000000",
          baseSha: seeded.baselineSha,
          findings: [],
          evidenceAssessment: "wrong head",
          recommendation: "ready_for_human",
        })
        expect.unreachable()
      } catch (error) {
        expect(errorCode(error)).toBe("STALE_HEAD")
      }

      const first = await OrynService.submitReview({
        callerSessionID: review.workerSessionId,
        caseId: seeded.caseId,
        attemptId: seeded.attemptId,
        assignmentId: review.assignmentId,
        requestKey: "rk_review_submit_1",
        headSha: seeded.candidateSha,
        baseSha: seeded.baselineSha,
        findings: [finding("F1", "P1", "open")],
        evidenceAssessment: "baseline red, candidate green, one regression risk open",
        recommendation: "changes_required",
      })
      expect(first.accepted).toBe(true)

      // Rework rotates the attempt onto the frozen candidate.
      const reworked = await OrynService.rework({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        reason: "F1 regression risk must be addressed",
      })
      expect(reworked.handedOff).toBe(false)
      const previous = await OrynStore.getAttempt(seeded.caseId, seeded.attemptId)
      expect(previous?.disposition).toBe("superseded")
      expect(previous?.invalidationReason).toContain("F1")
      const next = await OrynStore.getAttempt(seeded.caseId, reworked.attemptId)
      expect(next?.baselineSha).toBe(seeded.candidateSha)

      // Case-level reproduction admits coding on the new attempt.
      const candidate2 = await freezeOnActive(root, seeded, "rk_code_r2")

      const review2Dispatch = await OrynService.dispatch({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        stage: "review",
        requestKey: "rk_review_2",
      })
      const attempt2 = await activeAttemptId(seeded.caseId)

      // An open finding cannot silently disappear between reviews.
      try {
        await OrynService.submitReview({
          callerSessionID: review2Dispatch.workerSessionId,
          caseId: seeded.caseId,
          attemptId: attempt2,
          assignmentId: review2Dispatch.assignmentId,
          requestKey: "rk_review_submit_2_dropped",
          headSha: candidate2,
          baseSha: seeded.candidateSha,
          findings: [],
          evidenceAssessment: "dropped the prior finding",
          recommendation: "ready_for_human",
        })
        expect.unreachable()
      } catch (error) {
        expect(errorCode(error)).toBe("EVIDENCE_INSUFFICIENT")
      }

      // Disposing it explicitly passes.
      const second = await OrynService.submitReview({
        callerSessionID: review2Dispatch.workerSessionId,
        caseId: seeded.caseId,
        attemptId: attempt2,
        assignmentId: review2Dispatch.assignmentId,
        requestKey: "rk_review_submit_2",
        headSha: candidate2,
        baseSha: seeded.candidateSha,
        findings: [finding("F1", "P1", "resolved")],
        evidenceAssessment: "F1 addressed and re-verified on the new candidate",
        recommendation: "ready_for_human",
      })
      expect(second.accepted).toBe(true)
    })
  })
})

describe("OrynService bounded rework", () => {
  test("repair-round cap hands the case to a human deterministically", async () => {
    await withRevScope({ maxRepairRounds: 1, maxNoProgressRounds: 2 }, async (root) => {
      const seeded = await seedFrozen(root)
      const first = await OrynService.rework({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        reason: "first rework inside cap",
      })
      expect(first.handedOff).toBe(false)
      expect(first.repairRounds).toBe(1)
      await freezeOnActive(root, seeded, "rk_code_cap2")
      const second = await OrynService.rework({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        reason: "second rework exceeds the cap",
      })
      expect(second.handedOff).toBe(true)
      const record = await OrynStore.getCase(seeded.caseId)
      expect(record?.control).toBe("human_owned")
      try {
        await OrynService.dispatch({
          callerSessionID: seeded.engineeringSessionId,
          caseId: seeded.caseId,
          stage: "code",
          requestKey: "rk_after_handoff",
        })
        expect.unreachable()
      } catch (error) {
        expect(errorCode(error)).toBe("HUMAN_OWNED")
      }
    })
  })

  test("rework without candidate progress hands off via the no-progress cap", async () => {
    await withRevScope({ maxRepairRounds: 9, maxNoProgressRounds: 1 }, async (root) => {
      const seeded = await seedFrozen(root)
      const r1 = await OrynService.rework({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        reason: "r1",
      })
      expect(r1.handedOff).toBe(false)
      await freezeOnActive(root, seeded, "rk_code_np2")
      const r2 = await OrynService.rework({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        reason: "r2",
      })
      expect(r2.handedOff).toBe(false)
      expect(r2.noProgressRounds).toBe(1)
      await freezeOnActive(root, seeded, "rk_code_np3")
      const r3 = await OrynService.rework({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        reason: "r3",
      })
      expect(r3.handedOff).toBe(true)
      const record = await OrynStore.getCase(seeded.caseId)
      expect(record?.control).toBe("human_owned")
    })
  })
})

describe("OrynService delivery gate", () => {
  test("fails closed until evidence, review, CI, and payload hygiene all pass", async () => {
    await withRevScope({}, async (root) => {
      const seeded = await seedFrozen(root)
      const caseId = seeded.caseId

      const verify = await OrynService.dispatch({
        callerSessionID: seeded.engineeringSessionId,
        caseId,
        stage: "verify",
        requestKey: "rk_verify_gate",
      })
      const candPlan = await OrynService.proposeCheck({
        callerSessionID: verify.workerSessionId,
        caseId,
        attemptId: seeded.attemptId,
        assignmentId: verify.assignmentId,
        scenario: "candidate passes the acceptance scenario",
        profileId: "quick",
        argv: [["echo", "candidate-ok"]],
        checks: ["acceptance scenario passes"],
      })
      const candRun = await OrynService.runCheck({
        callerSessionID: verify.workerSessionId,
        caseId,
        attemptId: seeded.attemptId,
        assignmentId: verify.assignmentId,
        planId: candPlan.planId,
        lane: "candidate",
        abort: new AbortController().signal,
      })
      expect(candRun.outcome).toBe("passed")

      const payload = `Fix forwarded-message handling\n\ncandidate: ${seeded.candidateSha}`

      // No review yet.
      const noReview = await OrynService.evaluateDelivery({
        callerSessionID: seeded.engineeringSessionId,
        caseId,
        ciStatus: "passed",
        payload,
      })
      expect(noReview.ready).toBe(false)
      expect(noReview.failures.some((f) => f.message.includes("no review"))).toBe(true)

      // An open blocker blocks ready.
      const review1 = await OrynService.dispatch({
        callerSessionID: seeded.engineeringSessionId,
        caseId,
        stage: "review",
        requestKey: "rk_review_gate_1",
      })
      await OrynService.submitReview({
        callerSessionID: review1.workerSessionId,
        caseId,
        attemptId: seeded.attemptId,
        assignmentId: review1.assignmentId,
        requestKey: "rk_review_gate_submit_1",
        headSha: seeded.candidateSha,
        baseSha: seeded.baselineSha,
        findings: [finding("FB", "P0", "open")],
        evidenceAssessment: "blocker found in the error path",
        recommendation: "changes_required",
      })
      const blocked = await OrynService.evaluateDelivery({
        callerSessionID: seeded.engineeringSessionId,
        caseId,
        ciStatus: "passed",
        payload,
      })
      expect(blocked.ready).toBe(false)
      expect(blocked.failures.some((f) => f.message.includes("open blocker"))).toBe(true)

      // Clean re-review disposes the blocker explicitly.
      const review2 = await OrynService.dispatch({
        callerSessionID: seeded.engineeringSessionId,
        caseId,
        stage: "review",
        requestKey: "rk_review_gate_2",
      })
      await OrynService.submitReview({
        callerSessionID: review2.workerSessionId,
        caseId,
        attemptId: seeded.attemptId,
        assignmentId: review2.assignmentId,
        requestKey: "rk_review_gate_submit_2",
        headSha: seeded.candidateSha,
        baseSha: seeded.baselineSha,
        findings: [finding("FB", "P0", "resolved")],
        evidenceAssessment: "blocker fixed and re-verified on the same candidate",
        recommendation: "ready_for_human",
      })

      // Unknown CI fails closed.
      const noCi = await OrynService.evaluateDelivery({
        callerSessionID: seeded.engineeringSessionId,
        caseId,
        payload,
      })
      expect(noCi.ready).toBe(false)
      expect(noCi.failures.some((f) => f.message.includes("CI status unknown"))).toBe(true)

      // A leaking credential rejects the payload.
      const leaking = await OrynService.evaluateDelivery({
        callerSessionID: seeded.engineeringSessionId,
        caseId,
        ciStatus: "passed",
        payload: `${payload}\ngithub_token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ`,
      })
      expect(leaking.ready).toBe(false)
      expect(leaking.failures.some((f) => f.code === "NOT_AUTHORIZED" && f.message.includes("GitHub token"))).toBe(true)

      // The payload must reference the frozen candidate.
      const stale = await OrynService.evaluateDelivery({
        callerSessionID: seeded.engineeringSessionId,
        caseId,
        ciStatus: "passed",
        payload: "fix summary without a sha",
      })
      expect(stale.ready).toBe(false)
      expect(stale.failures.some((f) => f.code === "STALE_HEAD")).toBe(true)

      // Human pause blocks delivery.
      const before = await OrynStore.getCase(caseId)
      await OrynStore.control(caseId, before!.revision, "pause")
      const paused = await OrynService.evaluateDelivery({
        callerSessionID: seeded.engineeringSessionId,
        caseId,
        ciStatus: "passed",
        payload,
      })
      expect(paused.ready).toBe(false)
      expect(paused.failures.some((f) => f.code === "HUMAN_OWNED")).toBe(true)

      // Resumed with everything green → ready.
      const pausedRecord = await OrynStore.getCase(caseId)
      await OrynStore.control(caseId, pausedRecord!.revision, "resume")
      const ready = await OrynService.evaluateDelivery({
        callerSessionID: seeded.engineeringSessionId,
        caseId,
        ciStatus: "passed",
        payload,
      })
      expect(ready.ready).toBe(true)
      expect(ready.failures).toEqual([])
    })
  })
})
