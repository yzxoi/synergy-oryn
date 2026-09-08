import { z } from "zod"
import type { ModelRequest, ModelStep } from "./model"

function content(request: ModelRequest, role?: string) {
  return request.messages
    .filter((message) => !role || message.role === role)
    .map((message) => {
      if (typeof message.content === "string") return message.content
      if (Array.isArray(message.content))
        return message.content
          .map((part) => (typeof part === "object" && part !== null && "text" in part ? part.text : ""))
          .join("\n")
      return ""
    })
    .join("\n")
}

function required(text: string, pattern: RegExp, field: string) {
  const value = pattern.exec(text)?.[1]
  if (!value) throw new Error(`scripted scenario has no ${field}: ${text.slice(-800)}`)
  return value
}

function completedCalls(request: ModelRequest) {
  const calls = new Map<string, { tool: string; input: Record<string, unknown> }>()
  const results: Array<{ tool: string; input: Record<string, unknown>; text: string }> = []
  for (const message of request.messages) {
    if (message.role === "assistant") {
      const parsed = z
        .array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) }))
        .safeParse(message.tool_calls)
      if (parsed.success)
        for (const call of parsed.data) {
          const input = z.record(z.string(), z.unknown()).parse(JSON.parse(call.function.arguments))
          calls.set(call.id, { tool: call.function.name, input })
        }
    }
    if (message.role === "tool" && message.tool_call_id) {
      const call = calls.get(message.tool_call_id)
      if (call)
        results.push({
          ...call,
          text: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
        })
    }
  }
  return results
}

export function attachmentScenario(options: { baseline: string; repair: boolean }) {
  const baseline = options.baseline
  const rework = options.repair
  return async (request: ModelRequest): Promise<ModelStep> => {
    const has = (name: string) => request.tools?.some((tool) => tool.function.name === name)
    const text = content(request)
    const results = content(request, "tool")
    if (has("oryn_reply") && !has("oryn_dispatch")) {
      if (!results.includes("caseId:"))
        return {
          tool: "oryn_case",
          input: {
            input: {
              action: "submit",
              requestKey: "attachment",
              kind: "bug",
              summary: "Forwarding drops attachments",
              observed: "A message with report.png returns no attachment",
              expected: "Forwarding returns report.png in an independent array",
            },
          },
        }
      if (!results.includes("entryId:"))
        return {
          tool: "oryn_reply",
          input: {
            kind: "accepted",
            caseId: required(results, /caseId: ([^\s\\]+)/, "QA Case"),
            text: "已记录，后台开始调查。",
          },
        }
      return { text: "Internal QA completion" }
    }
    if (has("oryn_dispatch")) {
      const caseId = required(text, /Investigate Oryn case ([^\s.]+)/, "engineering Case")
      const completed = completedCalls(request)
      const publications = new Set(
        completed
          .filter((call) => call.tool === "oryn_publish" && call.text.includes("acknowledged"))
          .map((call) => call.input.requestKey),
      )
      const dispatched = new Set(
        completed
          .filter((call) => call.tool === "oryn_dispatch" && call.text.includes("assignmentId:"))
          .map((call) => z.record(z.string(), z.unknown()).parse(call.input.input).requestKey),
      )
      const round = results.includes("handedOff: false") ? 1 : 0
      const currentResults = results.split("handedOff: false").at(-1)!
      const key = (value: string) => `${round}:${value}`
      const publish = (operation: "ensure_issue" | "ensure_draft" | "refresh_pr" | "publish_review" | "mark_ready") => {
        return {
          tool: "oryn_publish",
          input: { caseId, operation, requestKey: key(operation), title: "fix: preserve forwarded attachments" },
        }
      }
      const dispatch = (stage: string) => {
        return {
          tool: "oryn_dispatch",
          input: { input: { action: "dispatch", caseId, stage, requestKey: key(stage) } },
        }
      }
      if (!publications.has("0:ensure_issue")) return publish("ensure_issue")
      if (!results.includes('"issueNumber":101'))
        throw new Error(`tracking issue was not acknowledged: ${results.slice(-1800)}`)
      const reportId = [...text.matchAll(/Oryn (?:repro|code|verify|review) result ([^\s]+) for assignment/g)].at(
        -1,
      )?.[1]
      if (reportId && !results.includes(`"id": "${reportId}"`))
        return { tool: "oryn_result", input: { input: { kind: "get", caseId, reportId } } }
      if (!dispatched.has(key("repro"))) return dispatch("repro")
      if (currentResults.includes('"outcome": "reproduced"') && !dispatched.has(key("code"))) return dispatch("code")
      if (currentResults.includes('"outcome": "candidate_ready"')) {
        const operation = round ? "refresh_pr" : "ensure_draft"
        if (!publications.has(key(operation))) return publish(operation)
        if (!currentResults.includes('"pullNumber":55'))
          throw new Error(`PR update was not acknowledged: ${currentResults.slice(-1800)}`)
        if (!dispatched.has(key("verify"))) return dispatch("verify")
      }
      if (
        (currentResults.includes('"outcome": "verified"') || currentResults.includes('"outcome": "failed"')) &&
        !dispatched.has(key("review"))
      )
        return dispatch("review")
      if (currentResults.includes('"recommendation": "changes_required"')) {
        if (!publications.has(key("publish_review"))) return publish("publish_review")
        return {
          tool: "oryn_dispatch",
          input: {
            input: {
              action: "rework",
              caseId,
              reason: "attachment-copy must be fixed without mutating the caller's array",
            },
          },
        }
      }
      if (currentResults.includes('"recommendation": "ready_for_human"')) {
        if (!publications.has(key("publish_review"))) return publish("publish_review")
        if (!publications.has(key("mark_ready"))) return publish("mark_ready")
        return { text: "Internal engineering completion" }
      }
      return { text: "Waiting for the independent worker report" }
    }
    if (has("oryn_result")) {
      const worker = {
        caseId: required(text, /Case: ([^\s]+)/, "worker Case"),
        attemptId: required(text, /Attempt: ([^\s]+)/, "worker Attempt"),
        assignmentId: required(text, /Oryn assignment ([^\s]+)/, "worker Assignment"),
      }
      const stage = required(text, /\(stage: ([^)]+)\)/, "worker stage")
      const round = required(text, /Baseline: ([^\s]+)/, "worker baseline") === baseline ? 0 : 1
      const faulty = rework && round === 0
      if (results.includes("reportId:") || results.includes("reviewId:")) return { text: "Internal worker completion" }
      const report = (input: Record<string, unknown>) => {
        return { tool: "oryn_result", input: { input: { ...worker, requestKey: stage, ...input } } }
      }
      if (round && (stage === "code" || stage === "review")) {
        if (!results.includes('"reviewReports"'))
          return { tool: "oryn_case", input: { input: { action: "get", caseId: worker.caseId } } }
        const priorReviews = JSON.parse(required(results, /"reviewReports":\s*(\[[\s\S]*?\])/, "prior reviews")) as {
          id: string
        }[]
        const prior = priorReviews[0]?.id
        if (!prior) throw new Error("rework has no prior review reference")
        if (!results.includes('"findings":'))
          return { tool: "oryn_result", input: { input: { kind: "get", caseId: worker.caseId, reportId: prior } } }
        if (!results.includes('"id": "attachment-copy"') || !results.includes('"disposition": "open"'))
          throw new Error("rework has no prior open attachment-copy finding")
      }
      if (stage === "code") {
        const directory = required(text, /Working directory: ([^\n]+)/, "code workspace")
        const completed = completedCalls(request)
        const codeStep = !completed.some((call) => call.tool === "read")
          ? 1
          : !completed.some((call) => call.tool === "write")
            ? 2
            : !results.includes("candidateSha:")
              ? 3
              : 4
        if (codeStep === 1) return { tool: "read", input: { filePath: `${directory}/forward.ts` } }
        if (codeStep === 2) {
          if (!results.includes(round ? "=> message.attachments" : "=> []"))
            throw new Error(`coder did not read the buggy implementation: ${results.slice(-1200)}`)
          return {
            tool: "write",
            input: {
              filePath: `${directory}/forward.ts`,
              content: faulty
                ? "export const forward = (message: { attachments: string[] }) => message.attachments\n"
                : "export const forward = (message: { attachments: string[] }) => [...message.attachments]\n",
            },
          }
        }
        if (codeStep === 3)
          return {
            tool: "oryn_result",
            input: {
              input: {
                kind: "commit_candidate",
                ...worker,
                requestKey: "commit",
                title: "fix: preserve attachments",
                paths: ["forward.ts"],
              },
            },
          }
        return report({
          kind: "candidate",
          outcome: "candidate_ready",
          summary: "Preserve an independent attachment list",
          addressedFindings: round ? ["attachment-copy"] : [],
          candidateSha: required(results, /candidateSha: ([0-9a-f]{40})/, "committed candidate"),
        })
      }
      if (stage === "review") {
        if (!results.includes(faulty ? "=> message.attachments" : "=> [...message.attachments]"))
          return {
            tool: "read",
            input: { filePath: `${required(text, /Working directory: ([^\n]+)/, "review workspace")}/forward.ts` },
          }
        if (!results.includes('"evidenceRunIds"'))
          return { tool: "oryn_case", input: { input: { action: "get", caseId: worker.caseId } } }
        const runIds =
          required(results, /"evidenceRunIds":\s*\[([^\]]+)\]/, "review evidence")
            .match(/"([^"]+)"/g)
            ?.map((id) => JSON.parse(id) as string) ?? []
        for (const runId of runIds)
          if (!results.includes(`"id": "${runId}"`))
            return { tool: "oryn_check", input: { input: { action: "get_run", caseId: worker.caseId, runId } } }
        if (
          !results.includes('"lane": "baseline"') ||
          !results.includes('"outcome": "failed"') ||
          !results.includes('"lane": "candidate"') ||
          !results.includes(faulty ? '"outcome": "failed"' : '"outcome": "passed"')
        )
          throw new Error("reviewer has no baseline and candidate execution evidence")
        return report({
          kind: "review",
          headSha: required(text, /Candidate: ([^\s]+)/, "review head"),
          baseSha: required(text, /Baseline: ([^\s]+)/, "review base"),
          findings: rework
            ? [
                {
                  id: "attachment-copy",
                  severity: "P1",
                  category: "correctness",
                  path: "forward.ts",
                  line: 1,
                  trigger: "Mutating the returned list mutates the caller's attachment list",
                  impact: "The forwarding result is not an independent snapshot",
                  evidenceRefs: runIds,
                  disposition: faulty ? "open" : "resolved",
                },
              ]
            : [],
          evidenceAssessment: faulty
            ? "The candidate returns the caller array directly and fails the identity assertion."
            : "The candidate copies the attachment array and passes both preservation and identity assertions.",
          recommendation: faulty ? "changes_required" : "ready_for_human",
        })
      }
      const runId = /runId: ([^\s\\]+)/.exec(results)?.[1]
      if (runId) {
        const expected = stage === "repro" || faulty ? "failed" : "passed"
        if (!results.includes(`outcome: ${expected}`))
          throw new Error(`unexpected ${stage} check result: ${results.slice(-1600)}`)
        return report({
          kind: stage === "repro" ? "repro" : "verification",
          outcome: stage === "repro" ? "reproduced" : faulty ? "failed" : "verified",
          summary:
            stage === "repro"
              ? round
                ? "The baseline aliases the caller attachment list"
                : "The baseline drops report.png"
              : faulty
                ? "The candidate aliases the caller attachment list"
                : "The fixed candidate preserves an independent attachment list",
          runIds: [runId],
        })
      }
      const planId = /planId: ([^\s\\]+)/.exec(results)?.[1]
      if (planId)
        return {
          tool: "oryn_check",
          input: {
            input: { action: "run", ...worker, planId, lane: stage === "repro" ? "baseline" : "candidate" },
          },
        }
      return {
        tool: "oryn_check",
        input: {
          input: {
            action: "propose",
            ...worker,
            scenario: "Forward a message containing report.png",
            profileId: "fixture",
            argv: [["bun", "check.ts"]],
            checks: [
              "the returned attachment list contains report.png",
              "the returned list is independent of the caller array",
            ],
          },
        },
      }
    }
    return { text: "Attachment investigation" }
  }
}
