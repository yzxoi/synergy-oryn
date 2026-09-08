import type { PublishExecuteInput, PublishFacts, PublishTransport } from "../../../src/oryn/publish"

export function mockGithub() {
  const calls: PublishExecuteInput[] = []
  let issue: PublishFacts["issue"]
  let pull: PublishFacts["pull"]
  let marker: string | undefined
  const repository = "acme/oryn-fixture"
  const transport: PublishTransport = {
    async execute(input) {
      if (input.repository !== repository) throw new Error("mock GitHub repository mismatch")
      if (marker && input.marker !== marker) throw new Error("mock GitHub marker mismatch")
      marker ??= input.marker
      calls.push(structuredClone(input))
      if (input.operation === "ensure_issue") {
        if (issue) throw new Error("duplicate issue creation")
        issue = { number: 101, title: input.title!, state: "open", markerPresent: true, authorIsApp: true }
        return { refs: { issueNumber: issue.number, url: `https://github.com/${repository}/issues/101` } }
      }
      if (input.operation === "ensure_draft") {
        if (!issue || pull || !input.candidateSha || !input.branch) throw new Error("invalid draft creation")
        pull = {
          number: 55,
          title: input.title!,
          headSha: input.candidateSha,
          headBranch: input.branch,
          baseRef: input.baseBranch!,
          draft: true,
          state: "open",
          markerPresent: true,
          authorIsApp: true,
        }
        return { refs: { pullNumber: pull.number, branch: pull.headBranch } }
      }
      if (!pull || input.candidateSha !== pull.headSha || input.pullNumber !== pull.number)
        throw new Error("mock GitHub candidate mismatch")
      if (input.operation === "mark_ready") pull.draft = false
      return { refs: { pullNumber: pull.number, branch: pull.headBranch } }
    },
    async observe(input) {
      if (input.repository !== repository) throw new Error("mock GitHub observation mismatch")
      return {
        ...(input.issueNumber === issue?.number ? { issue } : {}),
        ...(input.pullNumber === pull?.number ? { pull: pull && structuredClone(pull) } : {}),
        ci: { state: pull && (!input.ref || input.ref === pull.headSha) ? "success" : "none" },
      }
    },
  }
  return { calls, transport, pull: () => pull && structuredClone(pull) }
}
