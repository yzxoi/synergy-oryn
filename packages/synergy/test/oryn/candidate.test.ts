import { OrynIntegration } from "../../src/oryn/integration"
import { OrynGit } from "../../src/oryn/git"
import { Config } from "../../src/config/config"
import { symlink } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import { BossService } from "../../src/boss/boss"
import { OrynCandidateCommit } from "../../src/oryn/candidate-commit"
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

  test("candidate inspection does not execute configured Git clean filters", async () => {
    await fixture(async (input) => {
      await Bun.write(`${input.directory}/.gitattributes`, "filtered.txt filter=fixture\n")
      await Bun.write(`${input.directory}/filtered.txt`, "before")
      await Bun.$`git add .gitattributes filtered.txt`.cwd(input.directory).quiet()
      await Bun.$`git -c core.hooksPath=/dev/null commit --no-gpg-sign -m fixture`.cwd(input.directory).quiet()
      const sha = (await Bun.$`git rev-parse HEAD`.cwd(input.directory).text()).trim()
      await Bun.$`git config filter.fixture.clean ${"touch filter-executed; cat"}`.cwd(input.directory).quiet()
      // Equal file sizes force Git to inspect content instead of settling from size metadata.
      await Bun.write(`${input.directory}/filtered.txt`, "after!")
      await expect(OrynService.submitResult(report({ ...input, candidateSha: sha }))).rejects.toThrow("filters")
      expect(await Bun.file(`${input.directory}/filter-executed`).exists()).toBe(false)
      await Bun.$`git -c core.fsmonitor=false status --porcelain`.cwd(input.directory).quiet()
      expect(await Bun.file(`${input.directory}/filter-executed`).exists()).toBe(true)
    })
  })

  test("Git links are rejected before recursive submodule inspection", async () => {
    await fixture(async (input) => {
      await Bun.$`git update-index --add --cacheinfo ${`160000,${input.candidateSha},external`}`
        .cwd(input.directory)
        .quiet()
      await Bun.$`git -c core.hooksPath=/dev/null commit --no-gpg-sign -m fixture`.cwd(input.directory).quiet()
      const sha = (await Bun.$`git rev-parse HEAD`.cwd(input.directory).text()).trim()
      await expect(OrynService.submitResult(report({ ...input, candidateSha: sha }))).rejects.toThrow("submodule")
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

describe("Oryn Host candidate commits", () => {
  const request = (input: Parameters<Parameters<typeof fixture>[0]>[0]) => ({
    callerSessionID: input.callerSessionID,
    caseId: input.caseId,
    attemptId: input.attemptId,
    assignmentId: input.assignmentId,
    requestKey: "commit",
    title: "fix: preserve attachments",
    paths: ["fix.txt"],
    abort: new AbortController().signal,
  })

  test("commits only the assigned branch and repairs an interrupted index on replay", async () => {
    await fixture(async (input) => {
      const rootDirectory = (await Session.get(input.rootSessionID)).scope.directory
      const originalHead = (await Bun.$`git rev-parse HEAD`.cwd(rootDirectory).text()).trim()
      const originalStatus = (await Bun.$`git status --porcelain`.cwd(rootDirectory).text()).trim()
      await Bun.write(`${input.directory}/fix.txt`, "fixed")
      const first = await OrynCandidateCommit.create(request(input))
      expect(first.candidateSha).not.toBe(input.candidateSha)
      expect(first.localBranch).toBe(input.branch)
      expect(first.replayed).toBe(false)
      expect((await Bun.$`git rev-parse HEAD`.cwd(rootDirectory).text()).trim()).toBe(originalHead)
      expect((await Bun.$`git status --porcelain`.cwd(rootDirectory).text()).trim()).toBe(originalStatus)
      await Bun.$`git read-tree ${input.candidateSha}`.cwd(input.directory).quiet()
      expect(await OrynCandidateCommit.create(request(input))).toEqual({ ...first, replayed: true })
      expect((await Bun.$`git status --porcelain`.cwd(input.directory).text()).trim()).toBe("")
      expect((await OrynStore.getAttempt(input.caseId, input.attemptId))?.candidateSha).toBeUndefined()
      const accepted = await OrynService.submitResult(report({ ...input, candidateSha: first.candidateSha }))
      expect(accepted.accepted).toBe(true)
      await expect(OrynCandidateCommit.create(request(input))).rejects.toThrow()
    })
  })

  test("does not create a commit for omitted files, protected paths, or a different caller", async () => {
    await fixture(async (input) => {
      await Bun.write(`${input.directory}/fix.txt`, "fixed")
      await Bun.write(`${input.directory}/omitted.txt`, "uncommitted")
      for (const patch of [
        {},
        { paths: ["../outside"] },
        { paths: [".git/config"] },
        { paths: ["."] },
        { callerSessionID: input.rootSessionID },
      ]) {
        await expect(OrynCandidateCommit.create({ ...request(input), ...patch })).rejects.toThrow()
        expect((await Bun.$`git rev-parse HEAD`.cwd(input.directory).text()).trim()).toBe(input.candidateSha)
      }
      expect(await Bun.file(`${input.directory}/omitted.txt`).text()).toBe("uncommitted")
    })
  })

  test("rejects a changed replay rather than replacing the recorded commit", async () => {
    await fixture(async (input) => {
      await Bun.write(`${input.directory}/fix.txt`, "fixed")
      const first = await OrynCandidateCommit.create(request(input))
      await expect(OrynCandidateCommit.create({ ...request(input), requestKey: "different" })).rejects.toThrow()
      await Bun.write(`${input.directory}/fix.txt`, "different fix")
      await expect(OrynCandidateCommit.create(request(input))).rejects.toThrow()
      expect((await Bun.$`git rev-parse HEAD`.cwd(input.directory).text()).trim()).toBe(first.candidateSha)
      expect(await Bun.file(`${input.directory}/fix.txt`).text()).toBe("different fix")
    })
  })

  test("rejects cancellation and human takeover before Git mutation", async () => {
    await fixture(async (input) => {
      await Bun.write(`${input.directory}/fix.txt`, "fixed")
      await expect(OrynCandidateCommit.create({ ...request(input), abort: AbortSignal.abort() })).rejects.toThrow()
      const record = (await OrynStore.getCase(input.caseId))!
      await OrynStore.control(input.caseId, record.revision, "takeover")
      await expect(OrynCandidateCommit.create(request(input))).rejects.toThrow()
      expect((await Bun.$`git rev-parse HEAD`.cwd(input.directory).text()).trim()).toBe(input.candidateSha)
    })
  })
  test("does not execute repository hooks and rejects configured filters", async () => {
    await fixture(async (input) => {
      const common = (
        await Bun.$`git rev-parse --path-format=absolute --git-common-dir`.cwd(input.directory).text()
      ).trim()
      const hook = `${common}/hooks/pre-commit`
      await Bun.write(hook, "#!/bin/sh\nprintf hook-ran > hook-ran.txt\n")
      await Bun.$`chmod +x ${hook}`.quiet()
      await Bun.write(`${input.directory}/fix.txt`, "fixed")
      const first = await OrynCandidateCommit.create(request(input))
      expect(first.candidateSha).not.toBe(input.candidateSha)
      expect(await Bun.file(`${input.directory}/hook-ran.txt`).exists()).toBe(false)
      await Bun.$`git config filter.probe.clean 'touch filter-ran.txt'`.cwd(input.directory).quiet()
      await expect(OrynCandidateCommit.create(request(input))).rejects.toThrow()
      expect(await Bun.file(`${input.directory}/filter-ran.txt`).exists()).toBe(false)
    })
  })
  test("supports repository Skills while rejecting runtime metadata and symlink traversal", async () => {
    await fixture(async (input) => {
      await using outside = await tmpdir()
      await Bun.write(`${outside.path}/outside.txt`, "external")
      await symlink(outside.path, `${input.directory}/link`)
      await expect(OrynCandidateCommit.create({ ...request(input), paths: ["link/outside.txt"] })).rejects.toThrow()
      expect(await Bun.file(`${outside.path}/outside.txt`).text()).toBe("external")
      for (const file of [".synergy/tmp/file", ".synergy/worktrees/file", ".GIT/config", "C:outside"])
        await expect(OrynCandidateCommit.create({ ...request(input), paths: [file] })).rejects.toThrow()
      await Bun.write(`${input.directory}/.gitignore`, "/link\n/.synergy/*\n!/.synergy/skill/\n")
      const file = ".synergy/skill/check/SKILL.md"
      await Bun.write(`${input.directory}/${file}`, "# Candidate check workflow\n")
      const result = await OrynCandidateCommit.create({ ...request(input), paths: [".gitignore", file] })
      expect((await Bun.$`git show ${result.candidateSha + ":" + file}`.cwd(input.directory).text()).trim()).toBe(
        "# Candidate check workflow",
      )
    })
  })
})

test("Host prepares a real conflict and commits the resolved candidate with both parents", async () => {
  await fixture(async (input) => {
    const directory = input.directory
    await Bun.write(`${directory}/conflict.txt`, "topic\n")
    await Bun.$`git add conflict.txt`.cwd(directory).quiet()
    await Bun.$`git commit -m topic`.cwd(directory).quiet()
    const head = await OrynGit.read(directory, ["rev-parse", "HEAD"])
    await Bun.write(`${directory}/conflict.txt`, "target\n")
    await Bun.$`git add conflict.txt`.cwd(directory).quiet()
    const tree = await OrynGit.read(directory, ["write-tree"])
    const target = await OrynGit.read(directory, [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit-tree",
      tree,
      "-p",
      input.candidateSha,
      "-m",
      "target",
    ])
    await Bun.$`git restore --source=${head} --staged --worktree conflict.txt`.cwd(directory).quiet()
    await OrynStore.mutateAttempt(input.caseId, input.attemptId, (attempt) => ({ ...attempt, baselineSha: head }))
    const config = await Config.globalRaw()
    await Config.domainUpdate("runtime", {
      oryn: { ...config.oryn, repositories: { repo: { owner: "test", repo: "repo", directory } } },
    })
    OrynIntegration.setTargetResolver(async () => target)
    try {
      const abort = new AbortController().signal
      const prepared = await OrynIntegration.run({ ...input, action: "start", abort })
      expect(prepared.state).toBe("conflicts")
      expect((await OrynIntegration.run({ ...input, action: "start", abort })).state).toBe("conflicts")
      const request = {
        ...input,
        requestKey: "resolve-conflict",
        title: "fix: reconcile both changes",
        paths: ["conflict.txt"],
        abort,
      }
      await expect(OrynCandidateCommit.create(request)).rejects.toThrow("Resolve every integration conflict")
      await Bun.write(`${directory}/conflict.txt`, "topic and target\n")
      const candidate = await OrynCandidateCommit.create(request)
      expect(await OrynGit.read(directory, ["show", "-s", "--format=%P", candidate.candidateSha])).toBe(
        `${head} ${target}`,
      )
      expect((await OrynIntegration.get(input.caseId, input.attemptId))?.state).toBe("committed")
      expect((await OrynCandidateCommit.create(request)).candidateSha).toBe(candidate.candidateSha)
    } finally {
      OrynIntegration.setTargetResolver(undefined)
    }
  })
})
