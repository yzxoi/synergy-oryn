import { externalIdentityHash } from "../util/identity"
import type { Attempt, Case, ReviewReport, RunReceipt } from "./schema"
import { OrynGit } from "./git"
import { OrynPublicText } from "./public-text"
import { OrynStore, storeError } from "./store"
import { OrynCandidate } from "./candidate"
import { OrynEvidence } from "./evidence"

export namespace OrynPublication {
  export type Change = { status: string; path: string }

  export async function changes(directory: string, baseline: string, candidate: string): Promise<Change[]> {
    if (![baseline, candidate].every((sha) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)))
      throw storeError("INVALID_STAGE", "publication requires full source versions")
    const raw = await OrynGit.read(directory, [
      "diff",
      "--name-status",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      baseline,
      candidate,
      "--",
    ])
    const fields = raw.split("\0")
    if (fields.at(-1) === "") fields.pop()
    if (fields.length % 2) throw storeError("INVALID_STAGE", "candidate change list is incomplete")
    const changes: Change[] = []
    for (let index = 0; index < fields.length; index += 2) {
      const status = fields[index]!
      const path = fields[index + 1]!
      if (!/^[AMDTUXB]$/.test(status) || !path || path.startsWith("/") || path.split("/").includes(".."))
        throw storeError("INVALID_STAGE", "candidate change list is invalid")
      changes.push({ status, path })
    }
    return changes
  }

  export async function capture(input: {
    repository: string
    record: Case
    attempt: Attempt
    title?: string
    notes?: string
  }) {
    const { record, attempt } = input
    const assignments = await OrynStore.listAssignments(record.id)
    const code = assignments
      .filter(
        (assignment) => assignment.attemptId === attempt.id && assignment.stage === "code" && assignment.workspaceRef,
      )
      .at(-1)
    if (!code?.workspaceRef) throw storeError("ENVIRONMENT_UNAVAILABLE", "publication requires the candidate worktree")
    await OrynCandidate.verify({ assignment: code, attempt, candidateSha: attempt.candidateSha })
    const runs: RunReceipt[] = []
    for (const report of await OrynStore.listWorkerReports(record.id)) {
      if (report.attemptId !== attempt.id || !["repro", "verification"].includes(report.kind)) continue
      const assignment = assignments.find((assignment) => assignment.id === report.assignmentId)
      if (
        !assignment ||
        assignment.epoch !== record.epoch ||
        report.epoch !== record.epoch ||
        assignment.attemptId !== attempt.id ||
        assignment.stage !== (report.kind === "repro" ? "repro" : "verify") ||
        assignment.acceptedReportId !== report.id
      )
        continue
      runs.push(...(await OrynEvidence.reportRuns({ assignment, attempt, report })))
    }
    const digests = OrynEvidence.reviewDigests(record, attempt)
    const reviews = (await OrynStore.listReviews(record.id)).filter((review) => {
      const assignment = assignments.find((assignment) => assignment.id === review.assignmentId)
      return (
        assignment?.acceptedReportId === review.id &&
        assignment.epoch === record.epoch &&
        assignment.stage === "review" &&
        assignment.agentId === "oryn-review" &&
        assignment.attemptId === attempt.id &&
        attempt.reviewIds.includes(review.id) &&
        review.attemptId === attempt.id &&
        review.headSha === attempt.candidateSha &&
        review.baseSha === attempt.baselineSha &&
        review.policyDigest === digests.policyDigest &&
        review.evidenceDigest === digests.evidenceDigest &&
        review.domain === (assignment.reviewDomain ?? "general") &&
        assignment.frozenInputsDigest ===
          externalIdentityHash(attempt.baselineSha, attempt.candidateSha ?? "", record.acceptanceDigest, "review")
      )
    })
    return {
      ...render({
        ...input,
        changes: await changes(code.workspaceRef, attempt.baselineSha, attempt.candidateSha!),
        runs: [...new Map(runs.map((run) => [run.id, run])).values()],
        reviews,
      }),
      directory: code.workspaceRef,
    }
  }

  function text(value: string, limit = 4_000): string {
    if (value.length > limit) throw storeError("INVALID_STAGE", "public description exceeds its field limit")
    const violations = OrynPublicText.violations(value)
    if (violations.length) throw storeError("NOT_AUTHORIZED", `public description contains ${violations.join(", ")}`)
    return value
      .replace(/[\r\n]+/g, " ")
      .replace(/[\\`*_{}\[\]()<>|#!]/g, "\\$&")
      .replaceAll("@", "&#64;")
  }

  function title(record: Case, proposed?: string): string {
    const prefix = { bug: "fix", feature: "feat", performance: "perf", question: "docs", usage: "docs" }[record.kind]
    const value = proposed?.trim() || `${prefix}: ${record.summary.slice(0, 110)}`
    if (
      value.length > 180 ||
      /[\r\n]/.test(value) ||
      !/^(?:fix|feat|perf|docs|refactor|test|build|ci|chore)(?:\([^\r\n()]+\))?: .+/.test(value)
    )
      throw storeError("INVALID_STAGE", "publication title must be a concise conventional title")
    text(value, 180)
    return value.replaceAll("@", "＠")
  }

  export function issue(input: { record: Case; title?: string; notes?: string }) {
    const { record } = input
    const heading = input.title?.trim() || `${record.kind}: ${record.summary.slice(0, 110)}`
    text(heading, 180)
    return {
      title: heading.replace(/[\r\n]+/g, " ").replaceAll("@", "＠"),
      body: [
        "## Reported problem",
        text(record.summary),
        record.observed ? `Observed: ${text(record.observed)}` : undefined,
        record.expected ? `Expected: ${text(record.expected)}` : undefined,
        "This is a reported observation. Reproduction and engineering disposition are tracked separately.",
        input.notes ? `## Agent intake notes\n\n${text(input.notes)}` : undefined,
      ]
        .filter((line) => line !== undefined)
        .join("\n\n"),
    }
  }

  // Evidence-first sections follow OpenClaw's reviewed Feishu fix, without copying its body.
  // https://github.com/openclaw/openclaw/pull/136382
  export function render(input: {
    repository: string
    record: Case
    attempt: Attempt
    changes: Change[]
    runs: RunReceipt[]
    reviews: ReviewReport[]
    title?: string
    notes?: string
  }): { title: string; body: string } {
    const { record, attempt } = input
    if (!/^[\w.-]+\/[\w.-]+$/.test(input.repository) || !attempt.candidateSha || input.changes.length === 0)
      throw storeError("INVALID_STAGE", "a pull request requires a repository and a nonempty frozen candidate diff")
    const base = `https://github.com/${input.repository}`
    const shown = input.changes.slice(0, 50)
    const files = shown.map((change) => {
      const sha = change.status === "D" ? attempt.baselineSha : attempt.candidateSha
      const url = `${base}/blob/${sha}/${change.path.split("/").map(encodeURIComponent).join("/")}`
      return `| ${text(change.status, 1)} | [${text(change.path, 500)}](${url}) |`
    })
    const graph = [
      "flowchart LR",
      `  BASE[\"Base ${attempt.baselineSha.slice(0, 12)}\"]`,
      `  CANDIDATE[\"Candidate ${attempt.candidateSha.slice(0, 12)}\"]`,
    ]
    for (const [index, change] of shown.slice(0, 12).entries()) {
      const label = `${change.status}: ${change.path}`.replace(/[^\p{L}\p{N} /._:-]/gu, "_").slice(0, 120)
      graph.push(`  BASE --> C${index}[\"${label}\"]`, `  C${index} --> CANDIDATE`)
    }
    if (input.changes.length > 12)
      graph.push(`  BASE --> MORE[\"${input.changes.length - 12} additional changed files\"]`, "  MORE --> CANDIDATE")
    const runs = input.runs.slice(-30).map((run) => {
      const command =
        run.argvSummary.length > 500 || OrynPublicText.violations(run.argvSummary).length
          ? "Omitted: private context or excessive length"
          : text(run.argvSummary, 500)
      return `| ${run.lane} | ${run.outcome} | ${run.exitCode} | ${run.actualSha ?? "unknown"} | ${command} | ${externalIdentityHash(run.id).slice(0, 12)} |`
    })
    const reviews = input.reviews.slice(-10).map((review) => {
      const findings = review.findings
        .slice(0, 20)
        .map(
          (finding) =>
            `- ${finding.severity} (${finding.disposition}): ${text(finding.trigger, 1_000)} — ${text(finding.impact, 1_000)}${finding.path ? ` — ${text(finding.path, 500)}${finding.line ? `:${finding.line}` : ""}` : ""}`,
        )
      const questions = review.questions.map((question) => `- Human decision: ${text(question, 1_000)}`)
      return [
        `### ${review.domain}: ${review.recommendation}`,
        text(review.evidenceAssessment),
        ...findings,
        ...questions,
      ].join("\n\n")
    })
    const body = [
      "## Problem and expected behavior",
      text(record.summary),
      record.observed ? `Observed: ${text(record.observed)}` : undefined,
      record.expected ? `Expected: ${text(record.expected)}` : undefined,
      record.issueNumber ? `Closes #${record.issueNumber}` : undefined,
      "## Frozen candidate",
      `Base: ${attempt.baselineSha}\n\nCandidate: ${attempt.candidateSha}`,
      "## Changed scope",
      "This graph maps the Git diff; its arrows do not assert runtime dependencies.",
      `\`\`\`mermaid\n${graph.join("\n")}\n\`\`\``,
      `Files shown: ${shown.length} / ${input.changes.length}. A/M/D/T are Git change statuses; renames appear as deletion and addition.`,
      ["| Change | File |", "| --- | --- |", ...files].join("\n"),
      "## Execution evidence",
      runs.length
        ? [
            "| Lane | Recorded outcome | Exit | Source SHA | Command | Public receipt reference |",
            "| --- | --- | --- | --- | --- | --- |",
            ...runs,
          ].join("\n")
        : "No accepted execution evidence for this candidate attempt.",
      "Command outcomes do not by themselves establish application behavior or live-channel validation. Raw logs stay in the authorized workspace; commands containing private context are omitted.",
      "## Independent review",
      reviews.length ? reviews.join("\n\n") : "No accepted independent review for this candidate attempt.",
      input.notes ? `## Agent implementation notes\n\n${text(input.notes)}` : undefined,
      "## Human handoff",
      "Merge and release remain human-controlled. The current delivery check and independent evidence determine readiness; this description grants no approval.",
    ]
      .filter((line) => line !== undefined)
      .join("\n\n")
    if (body.length > 45_000) throw storeError("INVALID_STAGE", "public evidence summary exceeds its output limit")
    return { title: title(record, input.title), body }
  }
}
