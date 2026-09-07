import { describe, expect, test } from "bun:test"
import { BossService } from "../../src/boss/boss"
import { OrynService } from "../../src/oryn/service"
import { OrynStore } from "../../src/oryn/store"
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
    callerSessionID: string
    rootSessionID: string
    candidateSha: string
    directory: string
    branch: string
  }) => Promise<void>,
) {
  await using repo = await tmpdir({
    git: true,
    config: {
      oryn: {
        enabled: true,
        routes: [{ feishuAccount: "test", repoAlias: "repo" }],
        repositories: { repo: { owner: "test", repo: "repo" } },
      },
    },
  })
  await ScopeContext.provide({
    scope: await repo.scope(),
    fn: async () => {
      const identity = { provider: "feishu" as const, accountId: "test", chatId: repo.path }
      const { claim } = await OrynStore.claimSource({ identity, requestKey: "candidate" })
      await OrynStore.createCase({
        caseId: claim.caseId,
        kind: "bug",
        summary: "candidate",
        repoAlias: "repo",
        sourceKeyHash: claim.sourceKey,
      })
      const baseline = (await Bun.$`git rev-parse HEAD`.cwd(repo.path).text()).trim()
      const root = await OrynService.openEngineeringSession({ caseId: claim.caseId, identity, baselineSha: baseline })
      const worker = await BossService.spawn(root.sessionID, {
        role: "code",
        agent: "oryn-code",
        workspace: "worktree",
        baseRevision: baseline,
      })
      if (worker.workspace?.type !== "git_worktree") throw new Error("missing worker worktree")
      const directory = worker.workspace.path
      const branch = (await Bun.$`git branch --show-current`.cwd(directory).text()).trim()
      const assignment = await OrynStore.createAssignment({
        caseId: claim.caseId,
        attemptId: root.attemptId,
        stage: "code",
        agentId: "oryn-code",
        epoch: 0,
        frozenInputsDigest: "fixture",
        sessionId: worker.id,
      })
      await OrynStore.setAssignmentWorkspace(claim.caseId, assignment.id, directory)
      await OrynStore.bindSessionSource({ sessionID: worker.id, caseId: claim.caseId, role: "worker", identity })
      const lease = SessionManager.acquire(root.sessionID)
      if (!lease) throw new Error("root busy")
      try {
        await fn({
          caseId: claim.caseId,
          attemptId: root.attemptId,
          assignmentId: assignment.id,
          callerSessionID: worker.id,
          rootSessionID: root.sessionID,
          candidateSha: baseline,
          directory,
          branch,
        })
      } finally {
        await SessionInbox.removeByMode(root.sessionID, ["task", "steer", "context"])
        await SessionManager.release(lease, { requestNextWork: false })
        await Session.remove(root.sessionID)
      }
    },
  })
}

function report(input: {
  caseId: string
  attemptId: string
  assignmentId: string
  callerSessionID: string
  candidateSha: string
}) {
  return {
    ...input,
    requestKey: "candidate",
    kind: "candidate" as const,
    outcome: "candidate_ready",
    summary: "candidate",
  }
}

describe("Oryn candidate verification", () => {
  test("rejects a nonexistent SHA instead of freezing model text", async () => {
    await fixture(async (input) => {
      await expect(OrynService.submitResult(report({ ...input, candidateSha: "a".repeat(40) }))).rejects.toThrow()
      expect((await OrynStore.getAttempt(input.caseId, input.attemptId))?.candidateSha).toBeUndefined()
      expect((await OrynStore.getAssignment(input.caseId, input.assignmentId))?.acceptedReportId).toBeUndefined()
      await expect(
        OrynService.dispatch({
          callerSessionID: input.rootSessionID,
          caseId: input.caseId,
          stage: "review",
          requestKey: "unaccepted",
        }),
      ).rejects.toThrow()
    })
  })
  test("rejects an unrelated baseline and symbolic candidate references", async () => {
    await fixture(async (input) => {
      await expect(OrynService.submitResult(report({ ...input, candidateSha: "HEAD" }))).rejects.toThrow()
      const unrelated = (
        await Bun.$`git -c commit.gpgSign=false commit-tree HEAD^{tree} -m unrelated`.cwd(input.directory).text()
      ).trim()
      await OrynStore.mutateAttempt(input.caseId, input.attemptId, (attempt) => ({
        ...attempt,
        baselineSha: unrelated,
      }))
      await expect(OrynService.submitResult({ ...report(input), requestKey: "unrelated" })).rejects.toThrow()
      expect((await OrynStore.getAttempt(input.caseId, input.attemptId))?.candidateSha).toBeUndefined()
    })
  })

  test("rejects dirty tracked and untracked candidate files", async () => {
    await fixture(async (input) => {
      await Bun.write(`${input.directory}/uncommitted.txt`, "uncommitted")
      await expect(OrynService.submitResult(report(input))).rejects.toThrow()
      await Bun.$`git add uncommitted.txt`.cwd(input.directory).quiet()
      await expect(OrynService.submitResult(report(input))).rejects.toThrow()
      expect((await OrynStore.getAttempt(input.caseId, input.attemptId))?.candidateSha).toBeUndefined()
    })
  })
  test("rejects a different branch and a mismatched workspace binding", async () => {
    await fixture(async (input) => {
      await expect(OrynService.submitResult({ ...report(input), localBranch: "foreign" })).rejects.toThrow()
      await OrynStore.setAssignmentWorkspace(input.caseId, input.assignmentId, `${input.directory}/other`)
      await expect(OrynService.submitResult(report(input))).rejects.toThrow()
    })
  })
  test("freezes a real clean candidate and replay does not revise the Attempt", async () => {
    await fixture(async (input) => {
      await Bun.write(`${input.directory}/fix.txt`, "fixed")
      await Bun.$`git add fix.txt`.cwd(input.directory).quiet()
      await Bun.$`git -c core.hooksPath=/dev/null commit --no-gpg-sign -m fixture`.cwd(input.directory).quiet()
      const sha = (await Bun.$`git rev-parse HEAD`.cwd(input.directory).text()).trim()
      const request = { ...report({ ...input, candidateSha: sha }), localBranch: input.branch }
      const first = await OrynService.submitResult(request)
      expect(first.accepted).toBe(true)
      const frozen = await OrynStore.getAttempt(input.caseId, input.attemptId)
      expect(frozen?.candidateSha).toBe(sha)
      expect(await OrynService.submitResult(request)).toEqual(first)
      expect(await OrynStore.getAttempt(input.caseId, input.attemptId)).toEqual(frozen)
    })
  })
  test("delivery rechecks the candidate after it was frozen", async () => {
    await fixture(async (input) => {
      await OrynService.submitResult(report(input))
      const check = () => OrynService.evaluateDelivery({ callerSessionID: input.rootSessionID, caseId: input.caseId })
      expect((await check()).failures.some((failure) => failure.message.startsWith("candidate verification:"))).toBe(
        false,
      )
      await Bun.write(`${input.directory}/changed-after-freeze.txt`, "dirty")
      expect((await check()).failures.some((failure) => failure.message.startsWith("candidate verification:"))).toBe(
        true,
      )
    })
  })

  test("an already frozen Attempt cannot be replaced by a later commit", async () => {
    await fixture(async (input) => {
      await OrynService.submitResult(report(input))
      await Bun.$`git -c core.hooksPath=/dev/null commit --allow-empty --no-gpg-sign -m later`
        .cwd(input.directory)
        .quiet()
      const sha = (await Bun.$`git rev-parse HEAD`.cwd(input.directory).text()).trim()
      await expect(
        OrynService.submitResult({ ...report({ ...input, candidateSha: sha }), requestKey: "replacement" }),
      ).rejects.toThrow()
      expect((await OrynStore.getAttempt(input.caseId, input.attemptId))?.candidateSha).toBe(input.candidateSha)
    })
  })
})
