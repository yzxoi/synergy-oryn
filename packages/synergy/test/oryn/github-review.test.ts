import { Storage } from "../../src/storage/storage"
import { OrynPath } from "../../src/oryn/path"
import { migrations } from "../../src/oryn/migration"
import { expect, test } from "bun:test"
import { OrynGithub } from "../../src/oryn/github"
import { OrynGithubRuntime, setGithubRuntimeTransport } from "../../src/oryn/github-runtime"
import { OrynGithubStore } from "../../src/oryn/github-store"
import { OrynStore } from "../../src/oryn/store"
import { OrynGit } from "../../src/oryn/git"
import { OrynEvidence } from "../../src/oryn/evidence"
import { OrynPublish } from "../../src/oryn/publish"
import { tmpdir, githubConfig as globalConfig } from "./fixture"

test("external review requires independent reports, rejects stale heads and reconciles an uncertain publication without resend", async () => {
  await using repo = await tmpdir({ git: true })
  const baseSha = await OrynGit.read(repo.path, ["rev-parse", "HEAD"])
  await Bun.write(`${repo.path}/widget.ts`, "export const widget = 1\n")
  await Bun.$`git add widget.ts`.cwd(repo.path).quiet()
  await Bun.$`git commit -m "test: candidate"`.cwd(repo.path).quiet()
  const headSha = await OrynGit.read(repo.path, ["rev-parse", "HEAD"])
  const name = `r${crypto.randomUUID()}`
  const repository = `acme/${name}`
  await using config = await globalConfig({
    oryn: {
      enabled: true,
      repositories: {
        review: { owner: "acme", repo: name, directory: repo.path, githubAccount: "app", github: { enabled: true } },
      },
    },
  })
  let snapshot = {
    number: 7,
    kind: "pull" as const,
    title: "Fix widget",
    body: "Description",
    state: "open" as const,
    updatedAt: new Date().toISOString(),
    labels: [],
    comments: [],
    headSha,
    baseSha,
    mergeBaseSha: baseSha,
    draft: false,
  }
  const caseId = (await OrynGithub.accept({ accountId: "app", repository, repoAlias: "review", snapshot }))!
  await OrynStore.attachEngineeringSession(caseId, "review-root")
  const source = await OrynStore.getSource((await OrynStore.getCase(caseId))!.sourceIds[0]!)
  await OrynStore.bindSessionSource({
    sessionID: "review-root",
    identity: source!.identity,
    caseId,
    role: "engineering",
  })
  const initial = await OrynStore.ensureAttempt(caseId, { baselineSha: baseSha, baseBranchSha: baseSha })
  const attempt = await OrynStore.mutateAttempt(caseId, initial.id, (value) => ({
    ...value,
    candidateSha: headSha,
    disposition: "candidate_frozen",
  }))
  let sends = 0
  let found: number | undefined
  const previous = setGithubRuntimeTransport({
    current: async () => snapshot,
    fetch: async () => {},
    permission: async () => false,
    findReview: async () => found,
    review: async (input) => {
      sends++
      expect(input.headSha).toBe(headSha)
      expect(input.comments).toEqual([expect.objectContaining({ path: "widget.ts", line: 1, side: "RIGHT" })])
      throw new Error("response lost")
    },
  })
  try {
    await expect(OrynGithubRuntime.publishReview(caseId, "stranger")).rejects.toBeDefined()
    await expect(OrynGithubRuntime.publishReview(caseId, "review-root")).rejects.toBeDefined()
    const record = (await OrynStore.getCase(caseId))!
    const assignment = await OrynStore.createAssignment({
      caseId,
      attemptId: attempt.id,
      stage: "review",
      agentId: "oryn-review",
      epoch: record.epoch,
      frozenInputsDigest: OrynEvidence.assignmentDigest(record, attempt, "review"),
      reviewDomain: "general",
      requestKey: "review",
    })
    const report = await OrynStore.writeReview({
      caseId,
      attemptId: attempt.id,
      assignmentId: assignment.id,
      domain: "general",
      headSha,
      baseSha,
      ...OrynEvidence.reviewDigests(record, attempt),
      findings: [
        {
          id: "widget-finding",
          severity: "P2",
          category: "correctness",
          path: "widget.ts",
          line: 1,
          trigger: "The exported value is consumed as an ID",
          impact: "The constant value duplicates IDs",
          evidenceRefs: [],
          disposition: "open",
        },
      ],
      questions: [],
      designDecisions: [],
      evidenceAssessment: "Inspected the widget change. No execution was performed.",
      recommendation: "ready_for_human",
    })
    await OrynStore.acceptAssignmentReport(caseId, assignment.id, report.id)
    snapshot = { ...snapshot, headSha: "b".repeat(40) }
    await expect(OrynGithubRuntime.publishReview(caseId, "review-root")).rejects.toBeDefined()
    expect(sends).toBe(0)
    snapshot = { ...snapshot, headSha }
    expect((await OrynGithubRuntime.publishReview(caseId, "review-root")).state).toBe("ambiguous")
    expect((await OrynGithubRuntime.publishReview(caseId, "review-root")).state).toBe("ambiguous")
    expect(sends).toBe(1)
    found = 42
    await OrynGithubRuntime.recover()
    expect((await OrynGithubStore.get(caseId))?.reviewPublication?.remoteId).toBe(42)
    expect((await OrynGithubRuntime.publishReview(caseId, "review-root")).state).toBe("acknowledged")
    expect((await OrynGithubStore.get(caseId))?.state).toBe("waiting_author")
    await expect(
      OrynPublish.publish({ callerSessionID: "review-root", caseId, operation: "mark_ready", requestKey: "forbidden" }),
    ).rejects.toBeDefined()
  } finally {
    setGithubRuntimeTransport(previous)
  }
})

test("legacy review migration invalidates old diff inputs without inventing an updatable comment", async () => {
  const caseId = crypto.randomUUID()
  const snapshot = {
    number: 31,
    kind: "pull" as const,
    title: "Review",
    body: "",
    state: "open" as const,
    updatedAt: new Date().toISOString(),
    labels: [],
    comments: [],
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    baseRef: "dev",
  }
  const legacy = {
    schemaVersion: 1,
    caseId,
    repoAlias: "fixture",
    accountId: "app",
    repository: "acme/fixture",
    number: 31,
    mode: "review",
    snapshot,
    fingerprint: "old-policy",
    attemptFingerprint: "old-policy",
    state: "settled",
    commandIds: [],
    updatedAt: Date.now(),
    reviewPublication: {
      fingerprint: "old-policy",
      marker: "old-marker",
      body: "old review",
      state: "acknowledged",
      remoteId: 20,
    },
  }
  await Storage.write(OrynPath.githubWork(caseId), legacy)
  const upgrade = migrations.find((entry) => entry.id === "20260909-oryn-pr-review-versions")!
  await upgrade.up(() => {})
  const migrated = (await OrynGithubStore.get(caseId))!
  expect(migrated.state).toBe("queued")
  expect(migrated.attemptFingerprint).toBeUndefined()
  expect(migrated.reviewPublication).toBeUndefined()
  expect(migrated.reviewHistory?.[0]?.remoteId).toBe(20)
  expect(OrynGithubStore.fingerprint({ ...snapshot, baseSha: "c".repeat(40) })).toBe(migrated.fingerprint)
  await upgrade.up(() => {})
  expect(await OrynGithubStore.get(caseId)).toEqual(migrated)
})
