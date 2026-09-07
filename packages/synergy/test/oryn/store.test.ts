import { describe, expect, test } from "bun:test"
import { OrynStore, sourceKey } from "../../src/oryn/store"

const feishuSource = (chatId: string, messageId: string) =>
  ({
    provider: "feishu" as const,
    accountId: "acc_test",
    chatId,
    threadId: `thr_${chatId}`,
    messageId,
  }) satisfies Parameters<typeof sourceKey>[0]

describe("OrynStore intake claims", () => {
  test("concurrent submits of the same requestKey observe one claim and one caseId", async () => {
    const identity = feishuSource("chat_a", "msg_1")
    const results = await Promise.all(
      Array.from({ length: 8 }, () => OrynStore.claimSource({ identity, requestKey: "rk_same" })),
    )
    const caseIds = new Set(results.map((r) => r.claim.caseId))
    expect(caseIds.size).toBe(1)
    expect(results.filter((r) => r.created).length).toBe(1)
  })

  test("replaying the same requestKey later returns the existing claim", async () => {
    const identity = feishuSource("chat_a2", "msg_1")
    const first = await OrynStore.claimSource({ identity, requestKey: "rk_later" })
    const replay = await OrynStore.claimSource({ identity, requestKey: "rk_later" })
    expect(replay.created).toBe(false)
    expect(replay.claim.caseId).toBe(first.claim.caseId)
  })

  test("different sources claim different caseIds", async () => {
    const a = await OrynStore.claimSource({ identity: feishuSource("chat_b", "msg_1"), requestKey: "rk_a" })
    const b = await OrynStore.claimSource({ identity: feishuSource("chat_c", "msg_1"), requestKey: "rk_b" })
    expect(a.claim.caseId).not.toBe(b.claim.caseId)
  })

  test("incompleteClaims returns only non-terminal claims for recovery", async () => {
    const done = await OrynStore.claimSource({ identity: feishuSource("chat_d", "msg_done"), requestKey: "rk_d" })
    const open = await OrynStore.claimSource({ identity: feishuSource("chat_d", "msg_open"), requestKey: "rk_o" })
    await OrynStore.updateClaim(done.claim.sourceKey, "rk_d", { state: "completed" })
    const incomplete = await OrynStore.incompleteClaims()
    expect(incomplete.some((c) => c.sourceKey === open.claim.sourceKey)).toBe(true)
    expect(incomplete.some((c) => c.sourceKey === done.claim.sourceKey)).toBe(false)
  })

  test("a new requestKey from the same source opens a second case (one topic, many cases)", async () => {
    const identity = feishuSource("chat_multi", "msg_1")
    const first = await OrynStore.claimSource({ identity, requestKey: "rk_first" })
    const second = await OrynStore.claimSource({ identity, requestKey: "rk_second" })
    expect(first.claim.caseId).not.toBe(second.claim.caseId)
    const replay = await OrynStore.claimSource({ identity, requestKey: "rk_first" })
    expect(replay.claim.caseId).toBe(first.claim.caseId)
    expect(replay.created).toBe(false)
  })
})

describe("OrynStore case access control", () => {
  test("cross-source reads are rejected even with a valid caseId", async () => {
    const owner = await OrynStore.claimSource({ identity: feishuSource("chat_e", "msg_1"), requestKey: "rk_e" })
    const stranger = await OrynStore.claimSource({ identity: feishuSource("chat_f", "msg_1"), requestKey: "rk_f" })
    await OrynStore.recordSource({ identity: feishuSource("chat_e", "msg_1") })
    await OrynStore.createCase({
      caseId: owner.claim.caseId,
      kind: "bug",
      summary: "top-level message forwarding only shows a placeholder",
      repoAlias: "acme/widget",
      sourceKeyHash: owner.claim.sourceKey,
    })
    await expect(OrynStore.getCaseForSource(owner.claim.caseId, owner.claim.sourceKey)).resolves.toBeDefined()
    try {
      await OrynStore.getCaseForSource(owner.claim.caseId, stranger.claim.sourceKey)
      expect.unreachable()
    } catch (error) {
      expect((error as { name?: string }).name).toBe("OrynStoreError")
      expect((error as { data?: { code?: string } }).data?.code).toBe("NOT_AUTHORIZED")
    }
  })

  test("linking a second source grants that source read access and keeps the first", async () => {
    const first = await OrynStore.claimSource({ identity: feishuSource("chat_g", "msg_1"), requestKey: "rk_g" })
    const second = await OrynStore.claimSource({ identity: feishuSource("chat_h", "msg_1"), requestKey: "rk_h" })
    await OrynStore.recordSource({ identity: feishuSource("chat_g", "msg_1") })
    await OrynStore.recordSource({ identity: feishuSource("chat_h", "msg_1") })
    await OrynStore.createCase({
      caseId: first.claim.caseId,
      kind: "bug",
      summary: "shared issue",
      repoAlias: "acme/widget",
      sourceKeyHash: first.claim.sourceKey,
    })
    await OrynStore.linkSourceToCase(second.claim.sourceKey, first.claim.caseId)
    await expect(OrynStore.getCaseForSource(first.claim.caseId, first.claim.sourceKey)).resolves.toBeDefined()
    await expect(OrynStore.getCaseForSource(first.claim.caseId, second.claim.sourceKey)).resolves.toBeDefined()
  })
})

describe("OrynStore case mutation and control", () => {
  async function seededCase() {
    const claim = await OrynStore.claimSource({
      identity: feishuSource(`chat_${Math.random().toString(36).slice(2, 8)}`, "msg_seed"),
      requestKey: "rk_seed",
    })
    const record = await OrynStore.createCase({
      caseId: claim.claim.caseId,
      kind: "bug",
      summary: "baseline",
      repoAlias: "acme/widget",
      sourceKeyHash: claim.claim.sourceKey,
    })
    return { claim, record }
  }

  test("mutateCase rejects a stale expectedRevision and succeeds on the current one", async () => {
    const { record } = await seededCase()
    try {
      await OrynStore.mutateCase(record.id, record.revision + 5, (draft) => ({ ...draft, summary: "bad" }))
      expect.unreachable()
    } catch (error) {
      expect((error as { data?: { code?: string } }).data?.code).toBe("STALE_REVISION")
    }
    const next = await OrynStore.mutateCase(record.id, record.revision, (draft) => ({
      ...draft,
      summary: "updated summary",
    }))
    expect(next.revision).toBe(record.revision + 1)
    expect(next.summary).toBe("updated summary")
  })

  test("control transitions update state and takeover bumps the epoch", async () => {
    const { record } = await seededCase()
    const paused = await OrynStore.control(record.id, record.revision, "pause")
    expect(paused.control).toBe("paused")
    expect(paused.epoch).toBe(record.epoch)
    const resumed = await OrynStore.control(paused.id, paused.revision, "resume")
    expect(resumed.control).toBe("active")
    const taken = await OrynStore.control(resumed.id, resumed.revision, "takeover")
    expect(taken.control).toBe("human_owned")
    expect(taken.epoch).toBe(resumed.epoch + 1)
  })

  test("amendAcceptance rotates the acceptance digest and revision", async () => {
    const { record } = await seededCase()
    const amended = await OrynStore.amendAcceptance(record.id, record.revision, {
      expected: "forwarded content arrives",
    })
    expect(amended.acceptanceRevision).toBe(record.acceptanceRevision + 1)
    expect(amended.acceptanceDigest).not.toBe(record.acceptanceDigest)
  })
})

describe("OrynStore attempts, assignments, receipts", () => {
  test("assignment requestKey dedup finds the existing assignment on the same attempt", async () => {
    const claim = await OrynStore.claimSource({
      identity: feishuSource(`chat_${Math.random().toString(36).slice(2, 8)}`, "msg_att"),
      requestKey: "rk_att",
    })
    const record = await OrynStore.createCase({
      caseId: claim.claim.caseId,
      kind: "bug",
      summary: "attempt dedup",
      repoAlias: "acme/widget",
      sourceKeyHash: claim.claim.sourceKey,
    })
    const attempt = await OrynStore.createAttempt({ caseId: record.id, baselineSha: "deadbeef" })
    await OrynStore.setActiveAttempt(record.id, record.revision, attempt.id)
    const first = await OrynStore.createAssignment({
      caseId: record.id,
      attemptId: attempt.id,
      stage: "repro",
      agentId: "oryn-repro",
      frozenInputsDigest: "digest_1",
      epoch: 0,
      requestKey: "rk_dispatch_1",
    })
    const found = await OrynStore.findAssignmentByRequestKey(record.id, attempt.id, "rk_dispatch_1")
    expect(found?.id).toBe(first.id)
    const other = await OrynStore.findAssignmentByRequestKey(record.id, attempt.id, "rk_dispatch_2")
    expect(other).toBeUndefined()
  })

  test("run receipts and reviews persist under the case and attach to the attempt", async () => {
    const claim = await OrynStore.claimSource({
      identity: feishuSource(`chat_${Math.random().toString(36).slice(2, 8)}`, "msg_run"),
      requestKey: "rk_run",
    })
    const record = await OrynStore.createCase({
      caseId: claim.claim.caseId,
      kind: "bug",
      summary: "receipts",
      repoAlias: "acme/widget",
      sourceKeyHash: claim.claim.sourceKey,
    })
    const attempt = await OrynStore.createAttempt({ caseId: record.id, baselineSha: "aa11" })
    const assignment = await OrynStore.createAssignment({
      caseId: record.id,
      attemptId: attempt.id,
      stage: "repro",
      agentId: "oryn-repro",
      frozenInputsDigest: "d",
      epoch: 0,
    })
    const run = await OrynStore.writeRunReceipt({
      assignmentId: assignment.id,
      caseId: record.id,
      attemptId: attempt.id,
      planDigest: "p",
      lane: "baseline",
      profile: "default",
      argvSummary: "bun test",
      startedAt: 1,
      endedAt: 2,
      exitCode: 1,
      authenticity: "built_runtime",
      outcome: "failed",
    })
    const review = await OrynStore.writeReview({
      assignmentId: assignment.id,
      caseId: record.id,
      attemptId: attempt.id,
      headSha: "bb22",
      baseSha: "aa11",
      policyDigest: "pol",
      evidenceDigest: "ev",
      findings: [],
      evidenceAssessment: "baseline run failed as expected",
      recommendation: "changes_required",
    })
    expect((await OrynStore.getRun(record.id, run.id))?.outcome).toBe("failed")
    expect((await OrynStore.getReview(record.id, review.id))?.recommendation).toBe("changes_required")
    expect((await OrynStore.getAttempt(record.id, attempt.id))?.reviewIds).toContain(review.id)
  })

  test("actions track state transitions and epoch exposure for stale-action checks", async () => {
    const claim = await OrynStore.claimSource({
      identity: feishuSource(`chat_${Math.random().toString(36).slice(2, 8)}`, "msg_act"),
      requestKey: "rk_act",
    })
    const record = await OrynStore.createCase({
      caseId: claim.claim.caseId,
      kind: "bug",
      summary: "actions",
      repoAlias: "acme/widget",
      sourceKeyHash: claim.claim.sourceKey,
    })
    const action = await OrynStore.writeAction({
      caseId: record.id,
      operation: "ensure_issue",
      payloadDigest: "pd",
      expectedRevision: record.revision,
      epoch: 0,
      requestKey: "rk_publish_1",
      state: "prepared",
    })
    const inFlight = await OrynStore.mutateAction(action.id, (draft) => ({
      ...draft,
      state: "in_flight" as const,
      attempts: draft.attempts + 1,
    }))
    expect(inFlight.state).toBe("in_flight")
    expect(inFlight.attempts).toBe(1)
    const acknowledged = await OrynStore.mutateAction(action.id, (draft) => ({
      ...draft,
      state: "acknowledged" as const,
      remoteRefs: { issueNumber: 42 },
    }))
    expect(acknowledged.remoteRefs?.issueNumber).toBe(42)
  })

  test("learning candidates start proposed and can be promoted", async () => {
    const candidate = await OrynStore.writeLearning({
      caseId: "orc_learningtest",
      outcomeVersion: "v1",
      lesson: "forwarded messages need total-length check",
      applicability: "feishu channel",
      invalidation: "upstream provider change",
      evidenceRefs: ["oru_x"],
    })
    expect(candidate.promotionState).toBe("proposed")
    const promoted = await OrynStore.mutateLearning(candidate.id, (draft) => ({
      ...draft,
      promotionState: "promoted" as const,
      memoryRef: "mem_1",
    }))
    expect(promoted.promotionState).toBe("promoted")
  })
})
