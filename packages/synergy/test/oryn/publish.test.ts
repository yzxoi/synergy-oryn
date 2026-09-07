import { describe, expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { OrynService } from "../../src/oryn/service"
import { OrynStore } from "../../src/oryn/store"
import { OrynPublish, caseMarker, orynBranch, setTransport } from "../../src/oryn/publish"
import type { PublishExecuteInput, PublishExecuteResult, PublishTransport } from "../../src/oryn/publish"
import { PublishNonFastForwardError } from "../../src/channel/provider/github/publish"
import { tmpdir } from "../fixture/fixture"

function errorCode(error: unknown): string | undefined {
  return (error as { data?: { code?: string } })?.data?.code
}

const feishuIdentity = (chatId: string) =>
  ({
    provider: "feishu" as const,
    accountId: "acc_test",
    chatId,
    threadId: `thr_${chatId}`,
    messageId: `msg_${chatId}`,
  }) as const

async function withPubScope<T>(fn: (root: string) => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({
    git: true,
    config: {
      oryn: {
        enabled: true,
        routes: [{ feishuAccount: "acc_test", repoAlias: "acme/widget" }],
        repositories: { "acme/widget": { owner: "acme", repo: "widget", baseBranch: "dev" } },
        executionProfiles: {
          quick: { commandAllowlist: ["echo", "bun"], timeoutSeconds: 60, maxConcurrent: 1 },
        },
      },
    },
  })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn: () => fn(tmp.path) })
}

async function headSha(root: string): Promise<string> {
  return Bun.$`git rev-parse HEAD`
    .cwd(root)
    .text()
    .then((s) => s.trim())
}

async function activeAttemptId(caseId: string): Promise<string> {
  const record = await OrynStore.getCase(caseId)
  if (!record?.activeAttemptId) throw new Error(`no active attempt for ${caseId}`)
  return record.activeAttemptId
}

type Frozen = { caseId: string; engineeringSessionId: string; attemptId: string; candidateSha: string }

/** Case → engineering root → failing baseline → repro → code → frozen candidate. */
async function seedFrozen(root: string): Promise<Frozen> {
  const identity = feishuIdentity(`chat_${Math.random().toString(36).slice(2, 8)}`)
  await OrynStore.bindSessionSource({ sessionID: "ses_qa_pub", identity, role: "qa" })
  const submitted = await OrynService.submitCase({
    callerSessionID: "ses_qa_pub",
    requestKey: `rk_${Math.random().toString(36).slice(2, 8)}`,
    kind: "bug",
    summary: "publish pipeline case",
    expected: "fixed behavior",
  })
  const caseId = submitted.caseId
  const opened = await OrynService.openEngineeringSession({
    caseId,
    identity,
    baselineSha: await headSha(root),
  })
  const attemptId = await activeAttemptId(caseId)

  const repro = await OrynService.dispatch({
    callerSessionID: opened.sessionID,
    caseId,
    stage: "repro",
    requestKey: "rk_repro_pub",
  })
  const baselinePlan = await OrynService.proposeCheck({
    callerSessionID: repro.workerSessionId,
    caseId,
    attemptId,
    assignmentId: repro.assignmentId,
    scenario: "baseline fails as reported",
    profileId: "quick",
    argv: [["bun", "--print", "process.exit(1)"]],
    checks: ["baseline assertion"],
  })
  await OrynService.runCheck({
    callerSessionID: repro.workerSessionId,
    caseId,
    attemptId,
    assignmentId: repro.assignmentId,
    planId: baselinePlan.planId,
    lane: "baseline",
    abort: new AbortController().signal,
  })
  await OrynService.submitResult({
    callerSessionID: repro.workerSessionId,
    caseId,
    attemptId,
    assignmentId: repro.assignmentId,
    requestKey: "rk_repro_result_pub",
    kind: "repro",
    outcome: "reproduced",
    summary: "baseline assertion failed",
  })

  const code = await OrynService.dispatch({
    callerSessionID: opened.sessionID,
    caseId,
    stage: "code",
    requestKey: "rk_code_pub",
  })
  const candidateSha = await headSha(root)
  await OrynService.submitResult({
    callerSessionID: code.workerSessionId,
    caseId,
    attemptId,
    assignmentId: code.assignmentId,
    requestKey: "rk_candidate_pub",
    kind: "candidate",
    outcome: "candidate_ready",
    summary: "fix with regression test",
    candidateSha,
  })
  return { caseId, engineeringSessionId: opened.sessionID, attemptId, candidateSha }
}

/**
 * Deterministic transport: records execute calls and answers observe with
 * configurable remote facts so reconciliation paths are exercisable without
 * network access.
 */
function fakeTransport(input: {
  candidateSha: string
  marker: string
  /** Head SHA reported for the recorded pull request; undefined = no PR remotely. */
  pullHeadSha?: string
  /** Remote issue author/marker facts; undefined = no issue facts. */
  issue?: { markerPresent: boolean; authorIsApp: boolean }
  onExecute?: (call: PublishExecuteInput) => Promise<PublishExecuteResult>
}): PublishTransport & { calls: PublishExecuteInput[] } {
  const calls: PublishExecuteInput[] = []
  return {
    calls,
    async execute(call): Promise<PublishExecuteResult> {
      if (input.onExecute) return input.onExecute(call)
      calls.push(call)
      switch (call.operation) {
        case "ensure_issue":
          return { refs: { issueNumber: 101, url: "https://github.com/acme/widget/issues/101" } }
        case "ensure_draft":
          return { refs: { pullNumber: 55, branch: call.branch } }
        case "refresh_pr":
          return { refs: { pullNumber: 55, branch: call.branch } }
        case "publish_review":
          return { refs: { pullNumber: call.pullNumber } }
        case "mark_ready":
          return { refs: { checkRunId: 9001 } }
        default:
          return { refs: {} }
      }
    },
    async observe(query) {
      const facts: Awaited<ReturnType<PublishTransport["observe"]>> = { ci: { state: "none" } }
      if (query.issueNumber) {
        facts.issue = {
          number: query.issueNumber,
          title: "bug: forwarded message shows placeholder",
          state: "open",
          markerPresent: input.issue?.markerPresent ?? true,
          authorIsApp: input.issue?.authorIsApp ?? true,
        }
      }
      if (query.pullNumber) {
        const head = input.pullHeadSha ?? input.candidateSha
        facts.pull = {
          number: query.pullNumber,
          title: "fix: forwarded message",
          headSha: head,
          headBranch: orynBranch("any"),
          baseRef: "dev",
          state: "open",
          markerPresent: true,
          authorIsApp: true,
        }
      }
      return facts
    },
  }
}

describe("OrynPublish ledger", () => {
  test("ensure_issue creates once and replays idempotently", async () => {
    await withPubScope(async (root) => {
      const seeded = await seedFrozen(root)
      const transport = fakeTransport({
        candidateSha: seeded.candidateSha,
        marker: caseMarker(seeded.caseId),
      })
      setTransport(transport)

      const first = await OrynPublish.publish({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        operation: "ensure_issue",
        requestKey: "rk_issue_1",
        title: "bug: forwarded message shows placeholder",
        body: "engineering summary",
      })
      expect(first.state).toBe("acknowledged")
      expect(first.deduped).toBe(false)
      expect(first.refs?.issueNumber).toBe(101)
      const record = await OrynStore.getCase(seeded.caseId)
      expect(record?.issueNumber).toBe(101)
      expect(transport.calls).toHaveLength(1)
      // The stored body carries the hidden case marker for reconciliation.
      expect(transport.calls[0]?.body).toContain("<!-- oryn:")

      const replay = await OrynPublish.publish({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        operation: "ensure_issue",
        requestKey: "rk_issue_1",
        title: "bug: forwarded message shows placeholder",
      })
      expect(replay.state).toBe("acknowledged")
      expect(replay.deduped).toBe(true)
      expect(transport.calls).toHaveLength(1)
    })
  })

  test("non-engineering or foreign callers cannot publish", async () => {
    await withPubScope(async (root) => {
      const seeded = await seedFrozen(root)
      setTransport(fakeTransport({ candidateSha: seeded.candidateSha, marker: caseMarker(seeded.caseId) }))
      try {
        await OrynPublish.publish({
          callerSessionID: "ses_qa_pub",
          caseId: seeded.caseId,
          operation: "ensure_issue",
          requestKey: "rk_issue_role",
        })
        expect.unreachable()
      } catch (error) {
        expect(errorCode(error)).toBe("NOT_AUTHORIZED")
      }
    })
  })

  test("ensure_draft pushes the frozen candidate once and dedups against the recorded PR", async () => {
    await withPubScope(async (root) => {
      const seeded = await seedFrozen(root)
      const transport = fakeTransport({
        candidateSha: seeded.candidateSha,
        marker: caseMarker(seeded.caseId),
      })
      setTransport(transport)

      const created = await OrynPublish.publish({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        operation: "ensure_draft",
        requestKey: "rk_pr_1",
        title: "fix: forwarded message",
        body: "what changed and why",
      })
      expect(created.state).toBe("acknowledged")
      expect(created.refs?.pullNumber).toBe(55)
      const pushCall = transport.calls.find((c) => c.operation === "ensure_draft")
      expect(pushCall?.candidateSha).toBe(seeded.candidateSha)
      expect(pushCall?.branch).toBe(orynBranch(seeded.caseId))
      expect(pushCall?.baseBranch).toBe("dev")
      expect(pushCall?.directory).toBeTruthy()
      const record = await OrynStore.getCase(seeded.caseId)
      expect(record?.pullNumbers).toContain(55)

      // A new requestKey observes the recorded PR (head matches the frozen
      // candidate) and settles idempotently instead of creating a second PR.
      const deduped = await OrynPublish.publish({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        operation: "ensure_draft",
        requestKey: "rk_pr_2",
        title: "fix: forwarded message",
      })
      expect(deduped.state).toBe("acknowledged")
      expect(deduped.deduped).toBe(true)
      expect(transport.calls.filter((c) => c.operation === "ensure_draft")).toHaveLength(1)
    })
  })

  test("mark_ready fails closed before any action when the delivery gate is unsatisfied", async () => {
    await withPubScope(async (root) => {
      const seeded = await seedFrozen(root)
      const transport = fakeTransport({
        candidateSha: seeded.candidateSha,
        marker: caseMarker(seeded.caseId),
      })
      setTransport(transport)

      try {
        await OrynPublish.publish({
          callerSessionID: seeded.engineeringSessionId,
          caseId: seeded.caseId,
          operation: "mark_ready",
          requestKey: "rk_ready_1",
          payload: `fixed; verified at ${seeded.candidateSha}`,
        })
        expect.unreachable()
      } catch (error) {
        expect(errorCode(error)).toBe("EVIDENCE_INSUFFICIENT")
      }
      const actions = await OrynStore.listActions({ caseId: seeded.caseId })
      expect(actions).toHaveLength(0)
      expect(transport.calls).toHaveLength(0)
    })
  })

  test("transient failure parks the action as ambiguous and bounded reconciliation settles it", async () => {
    await withPubScope(async (root) => {
      const seeded = await seedFrozen(root)
      const marker = caseMarker(seeded.caseId)
      const ok = fakeTransport({ candidateSha: seeded.candidateSha, marker })
      setTransport(ok)
      await OrynPublish.publish({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        operation: "ensure_draft",
        requestKey: "rk_pr_amb",
        title: "fix",
      })

      // refresh_pr with an already-aborted signal → outcome unknown.
      const controller = new AbortController()
      controller.abort()
      const flaky = fakeTransport({
        candidateSha: seeded.candidateSha,
        marker,
        onExecute: async () => {
          throw new DOMException("The operation was aborted.", "AbortError")
        },
      })
      setTransport(flaky)
      try {
        await OrynPublish.publish(
          {
            callerSessionID: seeded.engineeringSessionId,
            caseId: seeded.caseId,
            operation: "refresh_pr",
            requestKey: "rk_refresh_amb",
          },
          controller.signal,
        )
        expect.unreachable()
      } catch (error) {
        expect(errorCode(error)).toBe("REMOTE_AMBIGUOUS")
      }
      const ambiguous = (await OrynStore.listActions({ caseId: seeded.caseId })).find(
        (a) => a.requestKey === "rk_refresh_amb",
      )
      expect(ambiguous?.state).toBe("ambiguous")

      // Reconciliation observes our marker + head + author and settles.
      setTransport(ok)
      const settled = await OrynPublish.reconcileAmbiguous(seeded.caseId, ambiguous!.id)
      expect(settled.state).toBe("acknowledged")
      const after = await OrynStore.getCase(seeded.caseId)
      expect(after?.control).toBe("active")
    })
  })

  test("reconciliation that stays uncertain pauses the case and never replays", async () => {
    await withPubScope(async (root) => {
      const seeded = await seedFrozen(root)
      const marker = caseMarker(seeded.caseId)
      const ok = fakeTransport({ candidateSha: seeded.candidateSha, marker })
      setTransport(ok)
      await OrynPublish.publish({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        operation: "ensure_draft",
        requestKey: "rk_pr_unc",
        title: "fix",
      })

      const controller = new AbortController()
      controller.abort()
      setTransport(
        fakeTransport({
          candidateSha: seeded.candidateSha,
          marker,
          onExecute: async () => {
            throw new DOMException("The operation was aborted.", "AbortError")
          },
        }),
      )
      try {
        await OrynPublish.publish(
          {
            callerSessionID: seeded.engineeringSessionId,
            caseId: seeded.caseId,
            operation: "refresh_pr",
            requestKey: "rk_refresh_unc",
          },
          controller.signal,
        )
        expect.unreachable()
      } catch {
        // ambiguous expected
      }
      const ambiguous = (await OrynStore.listActions({ caseId: seeded.caseId })).find(
        (a) => a.requestKey === "rk_refresh_unc",
      )!

      // Remote disagrees with our expectation (someone else owns the head):
      // reconciliation cancels the action and leaves the case paused.
      setTransport(
        fakeTransport({
          candidateSha: "differenthumanpushedsha",
          marker,
          pullHeadSha: "differenthumanpushedsha",
        }),
      )
      const settled = await OrynPublish.reconcileAmbiguous(seeded.caseId, ambiguous.id)
      expect(["cancelled", "ambiguous"]).toContain(settled.state)
      const record = await OrynStore.getCase(seeded.caseId)
      expect(record?.control).toBe("paused")
    })
  })

  test("takeover invalidates ambiguous actions at reconciliation", async () => {
    await withPubScope(async (root) => {
      const seeded = await seedFrozen(root)
      const marker = caseMarker(seeded.caseId)
      const ok = fakeTransport({ candidateSha: seeded.candidateSha, marker })
      setTransport(ok)
      await OrynPublish.publish({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        operation: "ensure_draft",
        requestKey: "rk_pr_ep",
        title: "fix",
      })

      const controller = new AbortController()
      controller.abort()
      setTransport(
        fakeTransport({
          candidateSha: seeded.candidateSha,
          marker,
          onExecute: async () => {
            throw new DOMException("The operation was aborted.", "AbortError")
          },
        }),
      )
      try {
        await OrynPublish.publish(
          {
            callerSessionID: seeded.engineeringSessionId,
            caseId: seeded.caseId,
            operation: "refresh_pr",
            requestKey: "rk_refresh_ep",
          },
          controller.signal,
        )
        expect.unreachable()
      } catch {
        // ambiguous expected
      }
      const ambiguous = (await OrynStore.listActions({ caseId: seeded.caseId })).find(
        (a) => a.requestKey === "rk_refresh_ep",
      )!

      // Human takeover bumps the epoch: the in-flight action is void.
      const record = (await OrynStore.getCase(seeded.caseId))!
      await OrynStore.control(seeded.caseId, record.revision, "takeover")
      const settled = await OrynPublish.reconcileAmbiguous(seeded.caseId, ambiguous.id)
      expect(settled.state).toBe("cancelled")
    })
  })

  test("non-fast-forward divergence is rejected deterministically, never retried", async () => {
    await withPubScope(async (root) => {
      const seeded = await seedFrozen(root)
      const marker = caseMarker(seeded.caseId)
      const ok = fakeTransport({ candidateSha: seeded.candidateSha, marker })
      setTransport(ok)
      await OrynPublish.publish({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        operation: "ensure_draft",
        requestKey: "rk_pr_ff",
        title: "fix",
      })

      setTransport(
        fakeTransport({
          candidateSha: seeded.candidateSha,
          marker,
          onExecute: async () => {
            throw new PublishNonFastForwardError(orynBranch(seeded.caseId), "! [rejected] fetch first")
          },
        }),
      )
      try {
        await OrynPublish.publish({
          callerSessionID: seeded.engineeringSessionId,
          caseId: seeded.caseId,
          operation: "refresh_pr",
          requestKey: "rk_refresh_ff",
        })
        expect.unreachable()
      } catch (error) {
        expect(errorCode(error)).toBe("REMOTE_AMBIGUOUS")
      }
      const rejected = (await OrynStore.listActions({ caseId: seeded.caseId })).find(
        (a) => a.requestKey === "rk_refresh_ff",
      )
      expect(rejected?.state).toBe("rejected")
      expect(rejected?.lastErrorClass).toBe("NON_FAST_FORWARD")

      // Replaying the failed requestKey is rejected; a new decision is needed.
      try {
        await OrynPublish.publish({
          callerSessionID: seeded.engineeringSessionId,
          caseId: seeded.caseId,
          operation: "refresh_pr",
          requestKey: "rk_refresh_ff",
        })
        expect.unreachable()
      } catch (error) {
        expect(errorCode(error)).toBe("INVALID_STAGE")
      }
    })
  })
})
