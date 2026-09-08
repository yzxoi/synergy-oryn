import { describe, expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { OrynService } from "../../src/oryn/service"
import { OrynStore } from "../../src/oryn/store"
import { OrynPublish, setTransport } from "../../src/oryn/publish"
import { Storage } from "../../src/storage/storage"
import { OrynPath } from "../../src/oryn/path"
import { OrynEvidence } from "../../src/oryn/evidence"
import { OrynControl } from "../../src/oryn/control"
import { OrynReady } from "../../src/oryn/ready"
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
  await acknowledgeReady(seeded)
  return { ...seeded, ...proposed }
}

async function acknowledgeReady(seeded: Frozen) {
  await OrynStore.mutateAttempt(seeded.caseId, seeded.attemptId, (draft) => ({ ...draft, disposition: "ready" }))
  await OrynStore.attachRemoteRefs(seeded.caseId, { pullNumber: 55 })
  const record = (await OrynStore.getCase(seeded.caseId))!
  await OrynStore.writeAction({
    caseId: record.id,
    operation: "mark_ready",
    payloadDigest: "fixture",
    expectedHead: seeded.candidateSha,
    expectedRevision: record.revision,
    epoch: record.epoch,
    readyTarget: {
      attemptId: seeded.attemptId,
      repository: "acme/widget",
      branch: `codex/oryn/${record.id}`,
      baseBranch: "dev",
      deliveryCheck: false,
    },
    requestKey: "learning-ready",
    state: "acknowledged",
    remoteRefs: { pullNumber: 55 },
  })
  OrynReady.setVerifier(async () => true)
}

describe("learning evidence provenance", () => {
  test.each(["empty", "unaccepted", "old attempt"] as const)("rejects %s evidence", async (kind) => {
    await withLearnScope({}, async (root) => {
      const seeded = await seedFrozen(root)
      let refs = [seeded.baselineRunId]
      if (kind === "empty") refs = []
      if (kind === "unaccepted") {
        const original = (await OrynStore.listWorkerReports(seeded.caseId))[0]
        const { id: _id, schemaVersion: _version, createdAt: _time, ...input } = original
        const orphan = await OrynStore.writeWorkerReport({ ...input, requestKey: "unaccepted-learning-report" })
        refs = [orphan.id]
      }
      if (kind === "old attempt")
        await OrynService.rework({
          callerSessionID: seeded.engineeringSessionId,
          caseId: seeded.caseId,
          reason: "replace candidate",
        })
      await expect(
        OrynLearning.propose({
          callerSessionID: seeded.engineeringSessionId,
          caseId: seeded.caseId,
          lesson: "A claim needs accepted evidence",
          applicability: "this candidate",
          invalidation: "new evidence",
          evidenceRefs: refs,
        }),
      ).rejects.toMatchObject({ data: { code: "EVIDENCE_INSUFFICIENT" } })
      expect(await OrynStore.listLearnings(seeded.caseId)).toEqual([])
    })
  })

  test("Host pins a fresh lesson to its repository, candidate and accepted evidence", async () => {
    await withLearnScope({}, async (root) => {
      const seeded = await proposedReadyLesson(root)
      expect(await OrynStore.getLearning(seeded.learningId)).toMatchObject({
        schemaVersion: 2,
        source: { repository: "acme/widget", attemptId: seeded.attemptId, candidateSha: seeded.candidateSha, epoch: 0 },
      })
    })
  })
})

test.each(["legacy", "changed receipt", "new attempt"] as const)(
  "promotion skips a lesson with %s provenance",
  async (change) => {
    await withLearnScope({ verifiedMemory: true }, async (root) => {
      const seeded = await proposedReadyLesson(root)
      if (change === "legacy")
        await OrynStore.mutateLearning(seeded.learningId, (draft) => ({ ...draft, source: undefined }))
      if (change === "changed receipt") {
        const run = (await OrynStore.getRun(seeded.caseId, seeded.baselineRunId))!
        await Storage.write(OrynPath.run(seeded.caseId, run.id), {
          ...run,
          observations: [...run.observations, "corrected observation"],
        })
      }
      if (change === "new attempt") {
        await OrynService.rework({
          callerSessionID: seeded.engineeringSessionId,
          caseId: seeded.caseId,
          reason: "new source provenance",
        })
        const attemptId = await activeAttemptId(seeded.caseId)
        await OrynStore.mutateAttempt(seeded.caseId, attemptId, (draft) => ({
          ...draft,
          candidateSha: seeded.candidateSha,
        }))
        await acknowledgeReady({ ...seeded, attemptId })
      }
      const writes: string[] = []
      setMemoryPromoter({
        async promote({ id }, commit) {
          return commit(() => {
            writes.push(id)
            return id
          })
        },
        async remove() {},
      })
      expect(await OrynLearning.promoteCase(seeded.caseId)).toEqual({ promoted: 0, skipped: 1 })
      expect(writes).toEqual([])
    })
  },
)

test("receipt correction during preparation prevents memory insertion", async () => {
  await withLearnScope({ verifiedMemory: true }, async (root) => {
    const seeded = await proposedReadyLesson(root)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const writes: string[] = []
    setMemoryPromoter({
      async promote({ id }, commit) {
        entered.resolve()
        await release.promise
        return commit(() => {
          writes.push(id)
          return id
        })
      },
      async remove() {},
    })
    const pending = OrynLearning.promoteCase(seeded.caseId).then(
      () => undefined,
      (error: unknown) => error,
    )
    try {
      await entered.promise
      const run = (await OrynStore.getRun(seeded.caseId, seeded.baselineRunId))!
      await Storage.write(OrynPath.run(seeded.caseId, run.id), {
        ...run,
        observations: [...run.observations, "corrected while preparing"],
      })
    } finally {
      release.resolve()
    }
    expect(await pending).toMatchObject({ data: { code: "EVIDENCE_INSUFFICIENT" } })
    expect(writes).toEqual([])
  })
})

test.each(["changes_required", "stale evidence"] as const)(
  "review references cannot fall back after a latest %s review",
  async (state) => {
    await withLearnScope({}, async (root) => {
      const seeded = await seedFrozen(root)
      const record = (await OrynStore.getCase(seeded.caseId))!
      const attempt = (await OrynStore.getAttempt(record.id, seeded.attemptId))!
      async function review(next: boolean) {
        const assignment = await OrynStore.createAssignment({
          caseId: record.id,
          attemptId: attempt.id,
          stage: "review",
          agentId: "oryn-review",
          epoch: record.epoch,
          frozenInputsDigest: OrynEvidence.assignmentDigest(record, attempt, "review"),
        })
        const result = await OrynStore.writeReview({
          caseId: record.id,
          attemptId: attempt.id,
          assignmentId: assignment.id,
          headSha: seeded.candidateSha,
          baseSha: attempt.baselineSha,
          ...OrynEvidence.reviewDigests(record, attempt),
          ...(next && state === "stale evidence" ? { evidenceDigest: "obsolete-evidence" } : {}),
          evidenceAssessment: "Fixture review assessment",
          findings: [],
          recommendation: next && state === "changes_required" ? "changes_required" : "ready_for_human",
        })
        return { assignment, result }
      }
      const first = await review(false)
      const propose = (ref: string) =>
        OrynLearning.propose({
          callerSessionID: seeded.engineeringSessionId,
          caseId: record.id,
          lesson: "Review-derived proposal",
          applicability: "this candidate",
          invalidation: "new review",
          evidenceRefs: [ref],
        })
      await expect(propose(first.result.id)).rejects.toMatchObject({ data: { code: "EVIDENCE_INSUFFICIENT" } })
      await OrynStore.acceptAssignmentReport(record.id, first.assignment.id, first.result.id)
      expect((await propose(first.result.id)).created).toBe(true)
      const last = await review(true)
      await OrynStore.acceptAssignmentReport(record.id, last.assignment.id, last.result.id)
      await expect(propose(first.result.id)).rejects.toMatchObject({ data: { code: "EVIDENCE_INSUFFICIENT" } })
      await expect(propose(last.result.id)).rejects.toMatchObject({ data: { code: "EVIDENCE_INSUFFICIENT" } })
    })
  },
)

test.each(["synthetic", "infrastructure", "wrong source"] as const)(
  "learning refuses %s run provenance",
  async (kind) => {
    await withLearnScope({}, async (root) => {
      const seeded = await seedFrozen(root)
      const run = (await OrynStore.getRun(seeded.caseId, seeded.baselineRunId))!
      await Storage.write(OrynPath.run(seeded.caseId, run.id), {
        ...run,
        ...(kind === "synthetic" ? { authenticity: "synthetic" } : {}),
        ...(kind === "infrastructure" ? { infrastructureFailure: true } : {}),
        ...(kind === "wrong source" ? { actualSha: seeded.candidateSha } : {}),
      })
      await expect(
        OrynLearning.propose({
          callerSessionID: seeded.engineeringSessionId,
          caseId: seeded.caseId,
          lesson: "Unsupported claim",
          applicability: "this candidate",
          invalidation: "new evidence",
          evidenceRefs: [run.id],
        }),
      ).rejects.toMatchObject({ data: { code: "EVIDENCE_INSUFFICIENT" } })
    })
  },
)

describe("current delivery learning gate", () => {
  test.each(["unacknowledged", "paused", "epoch", "attempt", "remote"] as const)(
    "%s delivery cannot promote a lesson",
    async (change) => {
      await withLearnScope({ verifiedMemory: true }, async (root) => {
        const seeded = await proposedReadyLesson(root)
        const record = (await OrynStore.getCase(seeded.caseId))!
        if (change === "unacknowledged") {
          const action = (await OrynStore.listActions({ caseId: record.id }))[0]
          await OrynStore.mutateAction(action.id, (draft) => ({ ...draft, state: "ambiguous" }))
        }
        if (change === "paused")
          await OrynStore.mutateCase(record.id, record.revision, (draft) => ({ ...draft, control: "paused" }))
        if (change === "epoch")
          await OrynStore.mutateCase(record.id, record.revision, (draft) => ({ ...draft, epoch: draft.epoch + 1 }))
        if (change === "attempt")
          await OrynService.rework({
            callerSessionID: seeded.engineeringSessionId,
            caseId: record.id,
            reason: "new delivery required",
          })
        if (change === "remote") OrynReady.setVerifier(async () => false)
        const writes: string[] = []
        setMemoryPromoter({
          async promote({ id }, commit) {
            return commit(() => {
              writes.push(id)
              return id
            })
          },
          async remove() {},
        })
        await expect(OrynLearning.promoteCase(record.id)).rejects.toMatchObject({ data: { code: "INVALID_STAGE" } })
        expect(writes).toEqual([])
        expect((await OrynStore.getLearning(seeded.learningId))?.promotionState).toBe("proposed")
      })
    },
  )
})

test.each(["preparation", "remote confirmation"] as const)(
  "pause completes during memory %s and prevents the pending commit",
  async (phase) => {
    await withLearnScope({ verifiedMemory: true }, async (root) => {
      const seeded = await proposedReadyLesson(root)
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let confirmations = 0
      OrynReady.setVerifier(async () => {
        confirmations++
        if (phase === "remote confirmation" && confirmations === 2) {
          entered.resolve()
          await release.promise
        }
        return true
      })
      const writes: string[] = []
      setMemoryPromoter({
        async promote({ id }, commit) {
          if (phase === "preparation") {
            entered.resolve()
            await release.promise
          }
          return commit(() => {
            writes.push(id)
            return id
          })
        },
        async remove() {},
      })
      const promotion = OrynLearning.promoteCase(seeded.caseId)
      const failure = promotion.then(
        () => undefined,
        (error: unknown) => error,
      )
      try {
        await entered.promise
        const record = (await OrynStore.getCase(seeded.caseId))!
        await OrynControl.change({ caseId: record.id, expectedRevision: record.revision, action: "pause" })
        expect((await OrynStore.getCase(record.id))?.control).toBe("paused")
        expect(writes).toEqual([])
      } finally {
        release.resolve()
        expect(await failure).toMatchObject({ data: { code: "INVALID_STAGE" } })
      }
      expect(writes).toEqual([])
      expect((await OrynStore.getLearning(seeded.learningId))?.promotionState).toBe("proposed")
    })
  },
)

describe("learning side-effect recovery", () => {
  test.each(["archived", "agent", "parent"] as const)(
    "a worker with changed %s identity cannot mutate learning",
    async (change) => {
      await withLearnScope({}, async (root) => {
        const seeded = await seedFrozen(root)
        const worker = (await OrynStore.listAssignments(seeded.caseId))[0]
        const sessionID = worker.sessionId
        if (!sessionID) throw new Error("fixture worker has no Session")
        const otherParent = change === "parent" ? await Session.create({}) : undefined
        await Session.update(sessionID, (session) => {
          if (change === "archived") session.time.archived = Date.now()
          if (change === "agent") session.agentOverride = "synergy"
          if (otherParent) session.parentID = otherParent.id
        })
        await expect(
          OrynLearning.propose({
            callerSessionID: sessionID,
            caseId: seeded.caseId,
            lesson: "changed identity",
            applicability: "unused",
            invalidation: "unused",
            evidenceRefs: [seeded.baselineRunId],
          }),
        ).rejects.toMatchObject({ data: { code: "NOT_AUTHORIZED" } })
        expect(await OrynStore.listLearnings(seeded.caseId)).toHaveLength(0)
      })
    },
  )

  test.each(["paused", "human_owned", "cancelled", "closed"] as const)(
    "%s Cases cannot mutate shared learning",
    async (control) => {
      await withLearnScope({ verifiedMemory: true }, async (root) => {
        const seeded = await proposedReadyLesson(root)
        const record = (await OrynStore.getCase(seeded.caseId))!
        await OrynStore.mutateCase(record.id, record.revision, (draft) => ({ ...draft, control }))
        let removals = 0
        setMemoryPromoter({
          async promote({ id }, commit) {
            return commit(() => id)
          },
          async remove() {
            removals++
          },
        })
        await expect(
          OrynLearning.propose({
            callerSessionID: seeded.engineeringSessionId,
            caseId: record.id,
            lesson: "inactive Case lesson",
            applicability: "unused",
            invalidation: "unused",
            evidenceRefs: [seeded.baselineRunId],
          }),
        ).rejects.toMatchObject({ data: { code: "HUMAN_OWNED" } })
        await expect(
          OrynLearning.invalidate({
            callerSessionID: seeded.engineeringSessionId,
            caseId: record.id,
            learningId: seeded.learningId,
            reason: "inactive withdrawal",
          }),
        ).rejects.toMatchObject({ data: { code: "HUMAN_OWNED" } })
        expect(removals).toBe(0)
        expect((await OrynStore.getLearning(seeded.learningId))?.promotionState).toBe("proposed")
      })
    },
  )

  test.each(["epoch", "attempt"] as const)(
    "a worker from a previous %s cannot propose or withdraw lessons",
    async (change) => {
      await withLearnScope({ verifiedMemory: true }, async (root) => {
        const seeded = await proposedReadyLesson(root)
        const worker = (await OrynStore.listAssignments(seeded.caseId))[0]
        const workerSessionId = worker.sessionId
        if (!workerSessionId) throw new Error("fixture worker has no Session")
        const record = (await OrynStore.getCase(seeded.caseId))!
        if (change === "epoch") {
          await OrynStore.mutateCase(record.id, record.revision, (draft) => ({ ...draft, epoch: draft.epoch + 1 }))
        } else {
          await OrynService.rework({
            callerSessionID: seeded.engineeringSessionId,
            caseId: record.id,
            reason: "new candidate required",
          })
        }
        let removals = 0
        setMemoryPromoter({
          async promote({ id }, commit) {
            return commit(() => id)
          },
          async remove() {
            removals++
          },
        })
        await expect(
          OrynLearning.propose({
            callerSessionID: workerSessionId,
            caseId: record.id,
            lesson: "stale worker lesson",
            applicability: "unused",
            invalidation: "unused",
            evidenceRefs: [seeded.baselineRunId],
          }),
        ).rejects.toMatchObject({ data: { code: "NOT_AUTHORIZED" } })
        await expect(
          OrynLearning.invalidate({
            callerSessionID: workerSessionId,
            caseId: record.id,
            learningId: seeded.learningId,
            reason: "stale worker withdrawal",
          }),
        ).rejects.toMatchObject({ data: { code: "NOT_AUTHORIZED" } })
        expect(removals).toBe(0)
      })
    },
  )

  test("a current worker can propose and withdraw its Case lesson", async () => {
    await withLearnScope({}, async (root) => {
      const seeded = await seedFrozen(root)
      const worker = (await OrynStore.listAssignments(seeded.caseId))[0]
      const workerSessionId = worker.sessionId
      if (!workerSessionId) throw new Error("fixture worker has no Session")
      setMemoryPromoter({
        async promote({ id }, commit) {
          return commit(() => id)
        },
        async remove() {},
      })
      const proposed = await OrynLearning.propose({
        callerSessionID: workerSessionId,
        caseId: seeded.caseId,
        lesson: "current worker lesson",
        applicability: "this candidate",
        invalidation: "new evidence",
        evidenceRefs: [seeded.baselineRunId],
      })
      expect(proposed.created).toBe(true)
      expect(
        (
          await OrynLearning.invalidate({
            callerSessionID: workerSessionId,
            caseId: seeded.caseId,
            learningId: proposed.learningId,
            reason: "superseded",
          })
        ).promotionState,
      ).toBe("rejected")
    })
  })

  test("expired unfinished Cases cannot submit new lessons", async () => {
    await withLearnScope({}, async (root) => {
      const seeded = await seedFrozen(root)
      const record = (await OrynStore.getCase(seeded.caseId))!
      await OrynStore.mutateCase(record.id, record.revision, (draft) => ({ ...draft, createdAt: 1 }))
      await expect(
        OrynLearning.propose({
          callerSessionID: seeded.engineeringSessionId,
          caseId: record.id,
          lesson: "over budget",
          applicability: "unused",
          invalidation: "unused",
          evidenceRefs: [seeded.baselineRunId],
        }),
      ).rejects.toMatchObject({ data: { code: "BUDGET_EXHAUSTED" } })
      expect(await OrynStore.listLearnings(record.id)).toHaveLength(0)
    })
  })

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
        async promote({ id }, commit) {
          return commit(() => id)
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
      const changed = await OrynLearning.propose({ ...input, applicability: "a different scope" })
      expect(changed.created).toBe(true)
      expect(changed.learningId).not.toBe(results[0].learningId)
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
        async promote(input, commit) {
          return commit(() => {
            const id = input.id
            memories.set(id, input.content)
            if (interrupted) {
              interrupted = false
              throw new Error("lost memory acknowledgment")
            }
            return id
          })
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
        async promote(input, commit) {
          return commit(() => {
            memories.set(input.id, input.content)
            throw new Error("lost memory acknowledgment")
          })
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
        async promote(input, commit) {
          writes++
          entered.resolve()
          await release.promise
          return commit(() => {
            memories.set(input.id, input.content)
            return input.id
          })
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
    OrynReady.setVerifier(async () => false)
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
        async promote({ id, title }, commit) {
          return commit(() => {
            written.push(title)
            return id
          })
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
        async promote({ id, title, content }, commit) {
          return commit(() => {
            written.push({ id, title, content })
            return id
          })
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
      await acknowledgeReady(seeded)
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
