import { describe, expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { OrynService } from "../../src/oryn/service"
import { OrynStore } from "../../src/oryn/store"
import { OrynPublish, setTransport } from "../../src/oryn/publish"
import { OrynLearning, setMemoryPromoter } from "../../src/oryn/learn"
import type { PublishExecuteInput, PublishExecuteResult, PublishTransport } from "../../src/oryn/publish"
import { tmpdir, runCheck } from "./fixture"

async function proposedReadyLesson(root: string) {
  const seeded = await seedFrozen(root)
  const proposed = await OrynLearning.propose({
    callerSessionID: seeded.engineeringSessionId,
    caseId: seeded.caseId,
    lesson: "A durable learning write has one identity",
    applicability: "publication recovery",
    invalidation: "when the evidence is superseded",
    evidenceRefs: [seeded.baselineRunId],
  })
  await OrynStore.mutateAttempt(seeded.caseId, seeded.attemptId, (draft) => ({ ...draft, disposition: "ready" }))
  return { ...seeded, ...proposed }
}

describe("learning side-effect recovery", () => {
  test("withdrawal preserves an acknowledged historical memory identity", async () => {
    await withLearnScope({ verifiedMemory: true }, async (root) => {
      const seeded = await proposedReadyLesson(root)
      await OrynStore.mutateLearning(seeded.learningId, (draft) => ({
        ...draft,
        promotionState: "promoted",
        memoryRef: "mem_historical_oryn_entry",
      }))
      const removed: string[] = []
      setMemoryPromoter({
        async promote({ id }) {
          return id
        },
        async remove(id) {
          removed.push(id)
        },
      })
      await OrynLearning.invalidate({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        learningId: seeded.learningId,
        reason: "superseded",
      })
      expect(removed).toEqual(["mem_historical_oryn_entry"])
      expect((await OrynStore.getLearning(seeded.learningId))?.promotionState).toBe("rejected")
    })
  })

  test("simultaneous identical proposals create one durable candidate", async () => {
    await withLearnScope({}, async (root) => {
      const seeded = await seedFrozen(root)
      const input = {
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        lesson: "Concurrent proposals have one identity",
        applicability: "recovery",
        invalidation: "new evidence",
        evidenceRefs: [seeded.baselineRunId],
      }
      const results = await Promise.all([OrynLearning.propose(input), OrynLearning.propose(input)])
      expect(new Set(results.map((result) => result.learningId)).size).toBe(1)
      expect(results.filter((result) => result.created)).toHaveLength(1)
      expect(await OrynStore.listLearnings(seeded.caseId)).toHaveLength(1)
    })
  })

  test("withdrawal stays retryable when the Library writer is unavailable", async () => {
    await withLearnScope({ verifiedMemory: true }, async (root) => {
      const seeded = await proposedReadyLesson(root)
      await expect(
        OrynLearning.invalidate({
          callerSessionID: seeded.engineeringSessionId,
          caseId: seeded.caseId,
          learningId: seeded.learningId,
          reason: "contradicted",
        }),
      ).rejects.toThrow("memory writer is required")
      expect((await OrynStore.getLearning(seeded.learningId))?.promotionState).toBe("proposed")
    })
  })

  test("a memory written before a lost acknowledgment is reused on retry", async () => {
    await withLearnScope({ verifiedMemory: true }, async (root) => {
      const seeded = await proposedReadyLesson(root)
      const memories = new Map<string, string>()
      let interrupted = true
      setMemoryPromoter({
        async promote(input) {
          const id = input.id
          memories.set(id, input.content)
          if (interrupted) {
            interrupted = false
            throw new Error("lost memory acknowledgment")
          }
          return id
        },
        async remove(id) {
          memories.delete(id)
        },
      })
      await expect(OrynLearning.promoteCase(seeded.caseId)).rejects.toThrow("lost memory acknowledgment")
      expect((await OrynStore.getLearning(seeded.learningId))?.promotionState).toBe("proposed")
      await OrynLearning.promoteCase(seeded.caseId)
      expect(memories.size).toBe(1)
      expect(memories.has((await OrynStore.getLearning(seeded.learningId))!.memoryRef!)).toBe(true)
    })
  })

  test("withdrawal removes an unacknowledged write and prevents later promotion", async () => {
    await withLearnScope({ verifiedMemory: true }, async (root) => {
      const seeded = await proposedReadyLesson(root)
      const memories = new Map<string, string>()
      setMemoryPromoter({
        async promote(input) {
          const id = input.id
          memories.set(id, input.content)
          throw new Error("lost memory acknowledgment")
        },
        async remove(id) {
          memories.delete(id)
        },
      })
      await expect(OrynLearning.promoteCase(seeded.caseId)).rejects.toThrow("lost memory acknowledgment")
      await OrynLearning.invalidate({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        learningId: seeded.learningId,
        reason: "contradicted",
      })
      expect(memories.size).toBe(0)
      expect(await OrynLearning.promoteCase(seeded.caseId)).toEqual({ promoted: 0, skipped: 1 })
    })
  })

  test("concurrent promotion and withdrawal settle as one removed memory", async () => {
    await withLearnScope({ verifiedMemory: true }, async (root) => {
      const seeded = await proposedReadyLesson(root)
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const memories = new Map<string, string>()
      let writes = 0
      setMemoryPromoter({
        async promote(input) {
          writes++
          entered.resolve()
          await release.promise
          const id = input.id
          memories.set(id, input.content)
          return id
        },
        async remove(id) {
          memories.delete(id)
        },
      })
      const promotion = OrynLearning.promoteCase(seeded.caseId)
      await entered.promise
      const replay = OrynLearning.promoteCase(seeded.caseId)
      const withdrawal = OrynLearning.invalidate({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        learningId: seeded.learningId,
        reason: "contradicted while writing",
      })
      release.resolve()
      await Promise.all([promotion, replay, withdrawal])
      expect(writes).toBe(1)
      expect(memories.size).toBe(0)
      expect((await OrynStore.getLearning(seeded.learningId))?.promotionState).toBe("rejected")
    })
  })
})

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

async function withLearnScope<T>(learning: { verifiedMemory?: boolean }, fn: (root: string) => Promise<T>): Promise<T> {
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
        learning,
      },
    },
  })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  const previous = setMemoryPromoter(undefined)
  try {
    return await ScopeContext.provide({ scope, fn: () => fn(tmp.path) })
  } finally {
    setMemoryPromoter(previous)
  }
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

type Frozen = {
  caseId: string
  engineeringSessionId: string
  attemptId: string
  candidateSha: string
  baselineRunId: string
}

/** Case → engineering root → failing baseline → repro → code → frozen candidate. */
async function seedFrozen(root: string): Promise<Frozen> {
  const identity = feishuIdentity(`chat_${Math.random().toString(36).slice(2, 8)}`)
  await OrynStore.bindSessionSource({ sessionID: "ses_qa_learn", identity, role: "qa" })
  const submitted = await OrynService.submitCase({
    callerSessionID: "ses_qa_learn",
    requestKey: `rk_${Math.random().toString(36).slice(2, 8)}`,
    kind: "bug",
    summary: "learning pipeline case",
    expected: "fixed behavior",
  })
  const caseId = submitted.caseId
  const opened = await OrynService.openEngineeringSession({
    caseId,
    identity,
    baselineSha: await headSha(root),
  })
  const attemptId = await activeAttemptId(caseId)

  const repro = await OrynService.dispatch({
    callerSessionID: opened.sessionID,
    caseId,
    stage: "repro",
    requestKey: "rk_repro_learn",
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
  const baselineRun = await runCheck({
    callerSessionID: repro.workerSessionId,
    caseId,
    attemptId,
    assignmentId: repro.assignmentId,
    planId: baselinePlan.planId,
    lane: "baseline",
    abort: new AbortController().signal,
  })
  await OrynService.submitResult({
    callerSessionID: repro.workerSessionId,
    caseId,
    attemptId,
    assignmentId: repro.assignmentId,
    requestKey: "rk_repro_result_learn",
    kind: "repro",
    outcome: "reproduced",
    summary: "baseline assertion failed",
    runIds: [baselineRun.runId],
  })

  const code = await OrynService.dispatch({
    callerSessionID: opened.sessionID,
    caseId,
    stage: "code",
    requestKey: "rk_code_learn",
  })
  const assignment = (await OrynStore.getAssignment(caseId, code.assignmentId))!
  await Bun.write(`${assignment.workspaceRef}/learning-fixture.txt`, "Candidate for the learning gate fixture\n")
  await Bun.$`git add -- learning-fixture.txt`.cwd(assignment.workspaceRef!).quiet()
  await Bun.$`git -c user.name=Fixture -c user.email=fixture@example.test commit -m ${"test: create learning candidate\n\nCo-authored-by: synergy-agent <299070056+synergy-agent@users.noreply.github.com>"}`
    .cwd(assignment.workspaceRef!)
    .quiet()
  const candidateSha = await headSha(assignment.workspaceRef!)
  await OrynService.submitResult({
    callerSessionID: code.workerSessionId,
    caseId,
    attemptId,
    assignmentId: code.assignmentId,
    requestKey: "rk_candidate_learn",
    kind: "candidate",
    outcome: "candidate_ready",
    summary: "fix with regression test",
    candidateSha,
  })
  return {
    caseId,
    engineeringSessionId: opened.sessionID,
    attemptId,
    candidateSha,
    baselineRunId: baselineRun.runId,
  }
}

function noopTransport(candidateSha: string): PublishTransport {
  return {
    async execute(_call): Promise<PublishExecuteResult> {
      return { refs: {} }
    },
    async observe(query) {
      const facts: Awaited<ReturnType<PublishTransport["observe"]>> = { ci: { state: "none" } }
      if (query.pullNumber) {
        facts.pull = {
          number: query.pullNumber,
          title: "fix",
          headSha: candidateSha,
          headBranch: `codex/oryn/${query.marker?.slice("<!-- oryn:".length, -" -->".length)}`,
          draft: true,
          baseRef: "dev",
          state: "open",
          markerPresent: true,
          authorIsApp: true,
        }
      }
      return facts
    },
  }
}

describe("OrynLearning", () => {
  test("proposals require case-scoped evidence refs", async () => {
    await withLearnScope({}, async (root) => {
      const seeded = await seedFrozen(root)
      try {
        await OrynLearning.propose({
          callerSessionID: seeded.engineeringSessionId,
          caseId: seeded.caseId,
          lesson: "unbacked claim",
          applicability: "acme/widget",
          invalidation: "never",
          evidenceRefs: ["oryn_run_fake_evidence"],
        })
        expect.unreachable()
      } catch (error) {
        expect(errorCode(error)).toBe("EVIDENCE_INSUFFICIENT")
      }
      const ok = await OrynLearning.propose({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        lesson: "empty baseline assertion runs fail fast",
        applicability: "acme/widget repro stage",
        invalidation: "when the runner reports errors differently",
        evidenceRefs: [seeded.baselineRunId],
      })
      expect(ok.created).toBe(true)
      const replay = await OrynLearning.propose({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        lesson: "empty baseline assertion runs fail fast",
        applicability: "acme/widget repro stage",
        invalidation: "when the runner reports errors differently",
        evidenceRefs: [seeded.baselineRunId],
      })
      expect(replay.created).toBe(false)
      expect(replay.learningId).toBe(ok.learningId)
    })
  })

  test("promotion is config-gated and requires a delivered attempt", async () => {
    await withLearnScope({}, async (root) => {
      const seeded = await seedFrozen(root)
      const written: string[] = []
      setMemoryPromoter({
        async promote({ id, title }) {
          written.push(title)
          return id
        },
        async remove() {},
      })
      const proposed = await OrynLearning.propose({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        lesson: "gated lesson",
        applicability: "acme/widget",
        invalidation: "never",
        evidenceRefs: [seeded.baselineRunId],
      })
      // Attempt not delivered yet → promotion refused even with a promoter.
      await OrynStore.attachRemoteRefs(seeded.caseId, { pullNumber: 55 })
      setTransport(noopTransport(seeded.candidateSha))
      try {
        await OrynPublish.publish({
          callerSessionID: seeded.engineeringSessionId,
          caseId: seeded.caseId,
          operation: "mark_ready",
          requestKey: "rk_ready_learn_gate",
          payload: `done at ${seeded.candidateSha}`,
        })
        expect.unreachable()
      } catch (error) {
        expect(errorCode(error)).toBe("EVIDENCE_INSUFFICIENT")
      }
      // Gate off (default) → promoteCase is a no-op even when eligible.
      await OrynStore.mutateAttempt(seeded.caseId, seeded.attemptId, (d) => ({
        ...d,
        disposition: "ready" as const,
      }))
      const result = await OrynLearning.promoteCase(seeded.caseId)
      expect(result.promoted).toBe(0)
      expect(written).toHaveLength(0)
      expect(proposed.learningId).toBeTruthy()
    })
  })

  test("verified-memory promotion promotes proposed lessons after delivery and withdrawal removes them", async () => {
    await withLearnScope({ verifiedMemory: true }, async (root) => {
      const seeded = await seedFrozen(root)
      const written: Array<{ id: string; title: string; content: string }> = []
      const removed: string[] = []
      setMemoryPromoter({
        async promote({ id, title, content }) {
          written.push({ id, title, content })
          return id
        },
        async remove(memoryId) {
          removed.push(memoryId)
        },
      })
      const proposed = await OrynLearning.propose({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        lesson: "candidate runs must cite frozen receipts",
        applicability: "acme/widget verification",
        invalidation: "when receipts gain per-assert granularity",
        evidenceRefs: [seeded.baselineRunId],
      })
      await OrynStore.mutateAttempt(seeded.caseId, seeded.attemptId, (d) => ({
        ...d,
        disposition: "ready" as const,
      }))
      const promoted = await OrynLearning.promoteCase(seeded.caseId)
      expect(promoted.promoted).toBe(1)
      expect(written).toHaveLength(1)
      expect(written[0]?.content).toContain("Invalid when:")
      expect(written[0]?.content).toContain(seeded.baselineRunId)
      const candidate = await OrynStore.getLearning(proposed.learningId)
      expect(candidate?.promotionState).toBe("promoted")
      expect(candidate?.memoryRef).toBe(written[0]?.id)

      // Withdrawal removes the promoted shared memory and rejects the record.
      const withdrawn = await OrynLearning.invalidate({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        learningId: proposed.learningId,
        reason: "lesson contradicted by later evidence",
      })
      expect(withdrawn.promotionState).toBe("rejected")
      expect(removed).toEqual([written[0]?.id])
    })
  })

  test("only engineering and worker roles may propose", async () => {
    await withLearnScope({}, async (root) => {
      const seeded = await seedFrozen(root)
      try {
        await OrynLearning.propose({
          callerSessionID: "ses_qa_learn",
          caseId: seeded.caseId,
          lesson: "qa cannot propose",
          applicability: "nowhere",
          invalidation: "never",
          evidenceRefs: [seeded.baselineRunId],
        })
        expect.unreachable()
      } catch (error) {
        expect(errorCode(error)).toBe("NOT_AUTHORIZED")
      }
    })
  })
})

describe("OrynPublish.readFacts", () => {
  test("linked QA sources read bounded facts; unlinked sessions are rejected", async () => {
    await withLearnScope({}, async (root) => {
      const seeded = await seedFrozen(root)
      await OrynStore.attachRemoteRefs(seeded.caseId, { pullNumber: 55 })
      setTransport(noopTransport(seeded.candidateSha))
      // QA source linked to the case can read.
      await OrynPublish.readFacts({ callerSessionID: "ses_qa_learn", caseId: seeded.caseId })
      // A session with no binding cannot.
      try {
        await OrynPublish.readFacts({ callerSessionID: "ses_unbound", caseId: seeded.caseId })
        expect.unreachable()
      } catch (error) {
        expect(errorCode(error)).toBe("NOT_AUTHORIZED")
      }
      // A bound engineering session for a different case cannot.
      const otherIdentity = feishuIdentity("chat_other_learn")
      await OrynStore.bindSessionSource({
        sessionID: "ses_eng_other",
        identity: otherIdentity,
        caseId: "orc_other",
        role: "engineering",
      })
      try {
        await OrynPublish.readFacts({ callerSessionID: "ses_eng_other", caseId: seeded.caseId })
        expect.unreachable()
      } catch (error) {
        expect(errorCode(error)).toBe("NOT_AUTHORIZED")
      }
    })
  })
})
