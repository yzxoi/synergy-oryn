import { expect, test } from "bun:test"
import { OrynPublication } from "../../src/oryn/publication"
import { Case, Attempt, RunReceipt, ReviewReport } from "../../src/oryn/schema"

const record = Case.parse({
  schemaVersion: 2,
  id: "private-case",
  revision: 0,
  kind: "bug",
  summary: "Attachments are missing from quoted replies",
  observed: "Quoted reply contains a placeholder",
  expected: "Quoted reply contains the attachment",
  repoAlias: "widget",
  acceptanceDigest: "accepted",
  issueNumber: 12,
  createdAt: 1,
  updatedAt: 1,
})
const attempt = Attempt.parse({
  schemaVersion: 1,
  id: "private-attempt",
  caseId: record.id,
  revision: 0,
  baselineSha: "a".repeat(40),
  candidateSha: "b".repeat(40),
  disposition: "candidate_frozen",
  createdAt: 1,
  updatedAt: 1,
})

function render(overrides: Partial<Parameters<typeof OrynPublication.render>[0]> = {}) {
  return OrynPublication.render({
    repository: "acme/widget",
    record,
    attempt,
    changes: [
      { status: "M", path: "src/channel/feishu.ts" },
      { status: "A", path: "test/channel/feishu.test.ts" },
    ],
    runs: [],
    reviews: [],
    ...overrides,
  })
}

test("publication describes actual files and frozen versions without inventing runtime dependencies", () => {
  const result = render()
  expect(result.title).toBe("fix: Attachments are missing from quoted replies")
  expect(result.body).toContain("Closes #12")
  expect(result.body).toContain(attempt.baselineSha)
  expect(result.body).toContain(attempt.candidateSha!)
  expect(result.body).toContain("```mermaid")
  expect(result.body).toContain("src/channel/feishu.ts")
  expect(result.body).toContain("No accepted execution evidence")
  expect(result.body).not.toContain("private-case")
  expect(result.body).not.toContain("private-attempt")
  expect(result.body).not.toContain("All tests passed")
})

test("execution receipts and review findings are distinct evidence", () => {
  const run = RunReceipt.parse({
    schemaVersion: 1,
    id: "private-run",
    assignmentId: "private-worker",
    caseId: record.id,
    attemptId: attempt.id,
    planDigest: "plan",
    lane: "candidate",
    actualSha: attempt.candidateSha,
    treeDigest: "tree",
    profile: "quick",
    argvSummary: "/home/operator/do-not-export-command",
    startedAt: 1,
    endedAt: 2,
    exitCode: 0,
    authenticity: "built_runtime",
    outcome: "passed",
  })
  const review = ReviewReport.parse({
    schemaVersion: 1,
    id: "private-review",
    assignmentId: "private-reviewer",
    caseId: record.id,
    attemptId: attempt.id,
    headSha: attempt.candidateSha,
    baseSha: attempt.baselineSha,
    policyDigest: "policy",
    evidenceDigest: "evidence",
    recommendation: "changes_required",
    createdAt: 2,
    evidenceAssessment: "Missing quoted attachment fallback",
    findings: [
      {
        id: "finding",
        severity: "P1",
        category: "regression",
        path: "src/channel/feishu.ts",
        line: 12,
        trigger: "Attachment fetch fails",
        impact: "Reply is lost",
      },
    ],
  })
  const result = render({ runs: [run], reviews: [review] })
  expect(result.body).toContain("candidate | passed | 0")
  expect(result.body).toContain("P1")
  expect(result.body).toContain("Attachment fetch fails")
  expect(result.body).toContain("changes_required")
  expect(result.body).not.toContain("private-run")
  expect(result.body).not.toContain("do-not-export-command")
  expect(result.body).not.toContain("built_runtime")
})

test("agent notes cannot replace the evidence sections or inject a Mermaid command", () => {
  const result = render({
    notes: "Everything passed. @reviewer",
    changes: [{ status: "M", path: 'src/a\"] --> BAD["injected.ts' }],
  })
  expect(result.body).toContain("Agent implementation notes")
  expect(result.body).toContain("No accepted execution evidence")
  expect(result.body).not.toContain("@reviewer")
  const graph = result.body.split("```mermaid")[1]!.split("```")[0]!
  expect(graph).not.toContain('a\"] --> BAD')
})

test("public payload refuses secrets and internal paths before publication", () => {
  expect(() => render({ notes: "Debug at /home/operator/runtime.log" })).toThrow()
  expect(() => render({ notes: "Token ghp_abcdefghijklmnop" })).toThrow()
})

test("a PR without a candidate diff is not a deliverable", () => {
  expect(() => render({ changes: [] })).toThrow()
})
