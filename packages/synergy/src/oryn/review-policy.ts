import { OrynCandidate } from "./candidate"
import { OrynGit } from "./git"
import { OrynStore, storeError } from "./store"
import { REVIEW_POLICY_VERSION, type Attempt, type Case, ReviewDomain } from "./schema"

export namespace OrynReviewPolicy {
  // These path rules establish a minimum; general review can request additional domains.
  export function classify(changes: OrynGit.Change[]): ReviewDomain[] {
    const domains = new Set<ReviewDomain>(["general"])
    for (const change of changes) {
      const file = change.path.toLowerCase()
      const words = new Set(file.split(/[/_.-]+/))
      if (
        [
          "auth",
          "authentication",
          "authorization",
          "credential",
          "credentials",
          "permission",
          "permissions",
          "sandbox",
          "security",
          "enforcement",
          "env",
        ].some((word) => words.has(word)) ||
        /(^|\/)(package\.json|bun\.lockb?|pnpm-lock\.yaml|cargo\.lock|requirements\.txt|pyproject\.toml|agents\.md)$/.test(
          file,
        ) ||
        file.includes(".synergy/skill/") ||
        file.includes(".agents/")
      )
        domains.add("security")
      if (
        ["storage", "store", "persistence", "database", "migration", "migrations"].some((word) => words.has(word)) ||
        file.endsWith(".sql")
      )
        domains.add("persistence")
      if (words.has("channel") || words.has("channels")) domains.add("channel")
      if (["publish", "publishing", "release"].some((word) => words.has(word))) domains.add("publishing")
      if (file.startsWith(".github/workflows/") || file.startsWith(".github/actions/")) {
        domains.add("publishing")
        domains.add("security")
      }
      if (file.startsWith("packages/synergy/src/oryn/")) {
        domains.add("security")
        domains.add("publishing")
      }
    }
    return ReviewDomain.options.filter((domain) => domains.has(domain))
  }

  export async function requirements(record: Case, attempt: Attempt) {
    if (!attempt.candidateSha) throw storeError("INVALID_STAGE", "review requirements need a frozen candidate")
    const assignments = await OrynStore.listAssignments(record.id)
    const code = assignments.find(
      (assignment) =>
        assignment.stage === "code" &&
        assignment.attemptId === attempt.id &&
        assignment.epoch === record.epoch &&
        assignment.acceptedReportId,
    )
    if (!code?.workspaceRef) throw storeError("INVALID_STAGE", "review requirements need the accepted code worktree")
    await OrynCandidate.verify({ assignment: code, attempt, candidateSha: attempt.candidateSha })
    const attempts = (await OrynStore.listAttempts(record.id)).sort(
      (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
    )
    const baseline = attempts[0]?.baselineSha
    if (!baseline) throw storeError("INVALID_STAGE", "review requirements need the original Case baseline")
    // Repair-only diffs omit risks introduced by earlier commits on the same PR.
    const changes = await OrynGit.changes(code.workspaceRef, baseline, attempt.candidateSha)
    const domains = new Set<ReviewDomain>(classify(changes))
    for (const assignment of assignments)
      if (assignment.stage === "review") domains.add(assignment.reviewDomain ?? "general")
    return { version: REVIEW_POLICY_VERSION, baseSha: baseline, headSha: attempt.candidateSha, domains: [...domains] }
  }
}
