import { expect, spyOn, test } from "bun:test"
import { OrynStore } from "../../src/oryn/store"
import { OrynPath } from "../../src/oryn/path"
import { Storage } from "../../src/storage/storage"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "./fixture"

async function fixture(fn: (input: Parameters<typeof OrynStore.rotateAttempt>[0]) => Promise<void>) {
  await using tmp = await tmpdir()
  return ScopeContext.provide({
    scope: (await Scope.fromDirectory(tmp.path)).scope,
    fn: async () => {
      const { claim } = await OrynStore.claimSource({
        identity: { provider: "feishu", accountId: "fixture", chatId: tmp.path },
        requestKey: "transition",
      })
      const record = await OrynStore.createCase({
        caseId: claim.caseId,
        kind: "bug",
        summary: "Recover a repair transition",
        repoAlias: "fixture",
        sourceKeyHash: claim.sourceKey,
      })
      const previous = await OrynStore.ensureAttempt(record.id, { baselineSha: "a".repeat(40) })
      await OrynStore.mutateAttempt(record.id, previous.id, (value) => ({
        ...value,
        candidateSha: "b".repeat(40),
        disposition: "candidate_frozen",
      }))
      await fn({
        caseId: record.id,
        fromAttemptId: previous.id,
        nextBaselineSha: "b".repeat(40),
        invalidationReason: "Independent review requested repair",
        countRepair: true,
        countNoProgress: true,
      })
    },
  })
}

for (const boundary of ["next", "previous", "case", "index"] as const)
  test(`Attempt transition recovers interrupted ${boundary} persistence without duplicate attempts or counters`, async () => {
    await fixture(async (input) => {
      const write = Storage.write
      const reserved = new Set<string>()
      let interrupted = false
      const fault = spyOn(Storage, "write").mockImplementation(async (key, value) => {
        const item = value as { id?: string; disposition?: string }
        const next = key.includes("attempts") && item.id !== input.fromAttemptId
        if (next && item.id) reserved.add(item.id)
        const target =
          boundary === "next"
            ? next
            : boundary === "previous"
              ? item.id === input.fromAttemptId && item.disposition === "superseded"
              : boundary === "case"
                ? key.join("/") === OrynPath.caseInfo(input.caseId).join("/")
                : key.includes("case_index")
        if (!interrupted && target) {
          interrupted = true
          throw new Error("fixture persistence interruption")
        }
        return write(key, value)
      })
      try {
        await expect(OrynStore.rotateAttempt(input)).rejects.toThrow("fixture persistence interruption")
      } finally {
        fault.mockRestore()
      }
      expect(interrupted).toBe(true)
      expect((await OrynStore.recoverAttemptTransitions()).failed).toBe(0)
      const recovered = await OrynStore.rotateAttempt(input)
      const replay = await OrynStore.rotateAttempt(input)
      expect(replay.next.id).toBe(recovered.next.id)
      if (reserved.size) expect(reserved).toEqual(new Set([recovered.next.id]))
      expect(await OrynStore.listAttempts(input.caseId)).toHaveLength(2)
      expect(replay.case).toMatchObject({ activeAttemptId: recovered.next.id, repairRounds: 1, noProgressRounds: 1 })
      expect(replay.previous.disposition).toBe("superseded")
      expect(replay.next).toMatchObject({ baselineSha: input.nextBaselineSha, evidenceRunIds: [], reviewIds: [] })
    })
  })

test("a completed transition rejects altered input and cannot cross an ownership epoch", async () => {
  await fixture(async (input) => {
    const first = await OrynStore.rotateAttempt(input)
    await expect(OrynStore.rotateAttempt({ ...input, countRepair: false })).rejects.toMatchObject({
      data: { code: "INVALID_STAGE" },
    })
    await OrynStore.control(input.caseId, first.case.revision, "takeover")
    await expect(OrynStore.rotateAttempt(input)).rejects.toMatchObject({ data: { code: "HUMAN_OWNED" } })
    expect((await OrynStore.getCase(input.caseId))?.activeAttemptId).toBe(first.next.id)
    expect(await OrynStore.listAttempts(input.caseId)).toHaveLength(2)
  })
})

test("recovery pauses a Case whose revision changed during an unfinished transition", async () => {
  await fixture(async (input) => {
    const write = Storage.write
    const fault = spyOn(Storage, "write").mockImplementation(async (key, value) => {
      if (key.join("/") === OrynPath.caseInfo(input.caseId).join("/")) throw new Error("fixture interruption")
      return write(key, value)
    })
    try {
      await expect(OrynStore.rotateAttempt(input)).rejects.toThrow("fixture interruption")
    } finally {
      fault.mockRestore()
    }
    const record = (await OrynStore.getCase(input.caseId))!
    await OrynStore.amendAcceptance(record.id, record.revision, { expected: "Changed acceptance" })
    expect((await OrynStore.recoverAttemptTransitions()).failed).toBe(1)
    expect((await OrynStore.getCase(record.id))?.control).toBe("paused")
    expect((await OrynStore.getCase(record.id))?.activeAttemptId).toBe(input.fromAttemptId)
  })
})

test("recovery preserves progressed replacements and skips superseded historical transitions", async () => {
  await fixture(async (input) => {
    const first = await OrynStore.rotateAttempt(input)
    await OrynStore.mutateAttempt(input.caseId, first.next.id, (value) => ({
      ...value,
      candidateSha: "c".repeat(40),
      disposition: "candidate_frozen",
      planDigest: "preserved-plan",
    }))
    expect((await OrynStore.rotateAttempt(input)).next.planDigest).toBe("preserved-plan")
    const second = await OrynStore.rotateAttempt({
      ...input,
      fromAttemptId: first.next.id,
      nextBaselineSha: "c".repeat(40),
    })
    expect((await OrynStore.recoverAttemptTransitions()).failed).toBe(0)
    const record = (await OrynStore.getCase(input.caseId))!
    expect(record).toMatchObject({ activeAttemptId: second.next.id, repairRounds: 2, noProgressRounds: 2 })
    expect(await OrynStore.listAttempts(input.caseId)).toHaveLength(3)
    expect((await OrynStore.getAttempt(input.caseId, first.next.id))?.planDigest).toBe("preserved-plan")
  })
})
