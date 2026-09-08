import { OrynReviewPolicy } from "../../src/oryn/review-policy"
import { OrynGit } from "../../src/oryn/git"
import { OrynPath } from "../../src/oryn/path"
import { Storage } from "../../src/storage/storage"
import { externalIdentityHash } from "../../src/util/identity"
import { OrynControl } from "../../src/oryn/control"
import { OrynCaseTool } from "../../src/oryn/tools"
import { Session } from "../../src/session"
import { describe, expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { OrynService } from "../../src/oryn/service"
import { OrynStore } from "../../src/oryn/store"
import { OrynPublish, caseMarker, orynBranch, setTransport } from "../../src/oryn/publish"
import type { PublishExecuteInput, PublishExecuteResult, PublishTransport } from "../../src/oryn/publish"
import { PublishGitUncertainError, PublishNonFastForwardError } from "../../src/channel/provider/github/push"
import { tmpdir, runCheck } from "./fixture"

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
  return await ScopeContext.provide({ scope, fn: () => fn(tmp.path) })
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
async function seedFrozen(root: string, paths = ["publication-fixture.txt"]): Promise<Frozen> {
  const identity = feishuIdentity(`chat_${Math.random().toString(36).slice(2, 8)}`)
  await OrynStore.bindSessionSource({ sessionID: "ses_qa_pub", identity, role: "qa" })
  const turnID = `turn_${identity.messageId}`
  await OrynStore.recordChannelTurn({ sessionID: "ses_qa_pub", rootID: turnID, identity, chatType: "group" })
  const submitted = await OrynService.submitCase({
    callerSessionID: "ses_qa_pub",
    turnID,
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
  const baselineRun = await runCheck({
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
    runIds: [baselineRun.runId],
  })

  const code = await OrynService.dispatch({
    callerSessionID: opened.sessionID,
    caseId,
    stage: "code",
    requestKey: "rk_code_pub",
  })
  const assignment = (await OrynStore.getAssignment(caseId, code.assignmentId))!
  for (const file of paths) await Bun.write(`${assignment.workspaceRef}/${file}`, "Fixed candidate fixture\n")
  await Bun.$`git add -- ${paths}`.cwd(assignment.workspaceRef!).quiet()
  await Bun.$`git -c user.name=Fixture -c user.email=fixture@example.test commit -m ${"fix: update publication fixture\n\nCo-authored-by: synergy-agent <299070056+synergy-agent@users.noreply.github.com>"}`
    .cwd(assignment.workspaceRef!)
    .quiet()
  const candidateSha = await headSha(assignment.workspaceRef!)
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

async function verifyFrozen(seeded: Frozen): Promise<void> {
  const { caseId, attemptId } = seeded
  const verify = await OrynService.dispatch({
    callerSessionID: seeded.engineeringSessionId,
    caseId,
    stage: "verify",
    requestKey: "ready-verify",
  })
  const plan = await OrynService.proposeCheck({
    callerSessionID: verify.workerSessionId,
    caseId,
    attemptId,
    assignmentId: verify.assignmentId,
    scenario: "delivery fixture",
    profileId: "quick",
    argv: [["echo", "candidate-ok"]],
    checks: ["fixture exits successfully"],
  })
  const run = await runCheck({
    callerSessionID: verify.workerSessionId,
    caseId,
    attemptId,
    assignmentId: verify.assignmentId,
    planId: plan.planId,
    lane: "candidate",
    abort: new AbortController().signal,
  })
  await OrynService.submitResult({
    callerSessionID: verify.workerSessionId,
    caseId,
    attemptId,
    assignmentId: verify.assignmentId,
    requestKey: "ready-verification",
    kind: "verification",
    outcome: "verified",
    summary: "Independent publication fixture check",
    runIds: [run.runId],
  })
  const review = await OrynService.dispatch({
    callerSessionID: seeded.engineeringSessionId,
    caseId,
    stage: "review",
    requestKey: "ready-review",
  })
  await OrynService.submitReview({
    callerSessionID: review.workerSessionId,
    caseId,
    attemptId,
    assignmentId: review.assignmentId,
    requestKey: "ready-reviewed",
    headSha: seeded.candidateSha,
    baseSha: (await OrynStore.getAttempt(caseId, attemptId))!.baselineSha,
    findings: [],
    evidenceAssessment: "Fixture meets publication criteria",
    recommendation: "ready_for_human",
  })
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
  draft?: boolean
  ci?: "none" | "success"
  /** Remote issue author/marker facts; undefined = no issue facts. */
  issue?: { markerPresent: boolean; authorIsApp: boolean }
  onExecute?: (call: PublishExecuteInput) => Promise<PublishExecuteResult>
}): PublishTransport & { calls: PublishExecuteInput[] } {
  const calls: PublishExecuteInput[] = []
  let draft = input.draft ?? true
  return {
    calls,
    async execute(call): Promise<PublishExecuteResult> {
      if (input.onExecute) {
        const result = await input.onExecute(call)
        if (call.operation === "mark_ready") draft = false
        return result
      }
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
          draft = false
          return { refs: { pullNumber: call.pullNumber, checkRunId: 9001 } }
        default:
          return { refs: {} }
      }
    },
    async observe(query) {
      const facts: Awaited<ReturnType<PublishTransport["observe"]>> = { ci: { state: input.ci ?? "none" } }
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
          headBranch: `codex/oryn/${input.marker.slice("<!-- oryn:".length, -" -->".length)}`,
          draft,
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
      await OrynStore.attachRemoteRefs(seeded.caseId, { pullNumber: 55 })
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

  test("polling cannot reconcile or duplicate an active publication", async () => {
    await withPubScope(async (root) => {
      const seeded = await seedFrozen(root)
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const transport = fakeTransport({
        candidateSha: seeded.candidateSha,
        marker: caseMarker(seeded.caseId),
        onExecute: async () => {
          entered.resolve()
          await release.promise
          return { refs: { issueNumber: 101 } }
        },
      })
      setTransport(transport)
      const request = {
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        operation: "ensure_issue" as const,
        requestKey: "held",
      }
      const publishing = OrynPublish.publish(request)
      try {
        await entered.promise
        await OrynPublish.reconcileAllAmbiguous()
        expect((await OrynStore.listActions({ caseId: seeded.caseId }))[0].state).toBe("in_flight")
        await expect(OrynPublish.publish(request)).rejects.toMatchObject({ data: { code: "INVALID_STAGE" } })
        expect((await OrynStore.getCase(seeded.caseId))?.control).toBe("active")
      } finally {
        release.resolve()
        await publishing
      }
      expect((await OrynPublish.publish(request)).deduped).toBe(true)
      expect(await OrynStore.listActions({ caseId: seeded.caseId })).toHaveLength(1)
    })
  })

  test.each(["prepared", "in_flight", "acknowledged"] as const)(
    "repairs a %s receipt and its missing Case link without another write",
    async (state) => {
      await withPubScope(async (root) => {
        const seeded = await seedFrozen(root)
        const record = (await OrynStore.getCase(seeded.caseId))!
        const action = await OrynStore.writeAction({
          caseId: record.id,
          operation: "ensure_issue",
          requestKey: "orphan",
          state,
          payloadDigest: "fixture",
          expectedRevision: record.revision,
          epoch: record.epoch,
          ...(state === "acknowledged" ? { remoteRefs: { issueNumber: 101 } } : {}),
        })
        let writes = 0
        setTransport({
          execute: async () => {
            writes++
            throw new Error("Must not replay writes")
          },
          observe: async () => ({
            issue: { number: 101, title: "Recovered issue", state: "open", authorIsApp: true, markerPresent: true },
            ci: { state: "none" },
          }),
        })
        await OrynPublish.reconcileAllAmbiguous()
        expect((await OrynStore.getAction(action.id))?.state).toBe("acknowledged")
        expect((await OrynStore.getCase(record.id))?.issueNumber).toBe(101)
        await OrynPublish.reconcileAllAmbiguous()
        expect(
          (
            await OrynPublish.publish({
              callerSessionID: seeded.engineeringSessionId,
              caseId: record.id,
              operation: "ensure_issue",
              requestKey: "orphan",
            })
          ).refs?.issueNumber,
        ).toBe(101)
        expect(writes).toBe(0)
      })
    },
  )

  test("an acknowledged receipt cannot attach links after an epoch change", async () => {
    await withPubScope(async (root) => {
      const seeded = await seedFrozen(root)
      const record = (await OrynStore.getCase(seeded.caseId))!
      const action = await OrynStore.writeAction({
        caseId: record.id,
        operation: "ensure_issue",
        requestKey: "old-epoch",
        state: "acknowledged",
        payloadDigest: "fixture",
        expectedRevision: record.revision,
        epoch: record.epoch,
        remoteRefs: { issueNumber: 101 },
      })
      await OrynStore.control(record.id, record.revision, "takeover")
      await OrynPublish.reconcileAmbiguous(record.id, action.id)
      expect((await OrynStore.getCase(record.id))?.issueNumber).toBeUndefined()
    })
  })

  test.each(["abort", "git-transport"])(
    "%s failure parks the action as ambiguous and bounded reconciliation settles it",
    async (kind) => {
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
          title: "fix: publication fixture",
        })

        // Neither cancellation nor a failed Git transport proves the remote write did not apply.
        const controller = new AbortController()
        if (kind === "abort") controller.abort()
        const flaky = fakeTransport({
          candidateSha: seeded.candidateSha,
          marker,
          onExecute: async () => {
            if (kind === "git-transport") throw new PublishGitUncertainError()
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
    },
  )

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
        title: "fix: publication fixture",
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
        title: "fix: publication fixture",
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
        title: "fix: publication fixture",
      })

      setTransport(
        fakeTransport({
          candidateSha: seeded.candidateSha,
          marker,
          onExecute: async () => {
            throw new PublishNonFastForwardError(orynBranch(seeded.caseId))
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

describe("Oryn ready publication and recovery", () => {
  test("QA cannot announce readiness without an acknowledged publication", async () => {
    await withPubScope(async (root) => {
      const seeded = await seedFrozen(root)
      await expect(
        OrynService.reply({ callerSessionID: "ses_qa_pub", caseId: seeded.caseId, kind: "ready", text: "It is ready" }),
      ).rejects.toMatchObject({ data: { code: "EVIDENCE_INSUFFICIENT" } })
      expect((await OrynStore.listPendingOutbox()).filter((entry) => entry.caseId === seeded.caseId)).toEqual([])
    })
  })

  test("ready publication sends immediately and QA cannot duplicate the Host result", async () => {
    await withPubScope(async (root) => {
      const seeded = await seedFrozen(root)
      await verifyFrozen(seeded)
      await OrynStore.attachRemoteRefs(seeded.caseId, { pullNumber: 55 })
      setTransport(
        fakeTransport({ candidateSha: seeded.candidateSha, marker: caseMarker(seeded.caseId), ci: "success" }),
      )
      const sent: string[] = []
      OrynService.setOutboxDeliverer(async ({ text }) => {
        sent.push(text)
      })
      try {
        await OrynPublish.publish({
          callerSessionID: seeded.engineeringSessionId,
          caseId: seeded.caseId,
          operation: "mark_ready",
          requestKey: "send-ready",
        })
        expect(sent).toEqual([
          `Fix is ready for human review: https://github.com/acme/widget/pull/55 (candidate ${seeded.candidateSha})`,
        ])
        await OrynService.reply({
          callerSessionID: "ses_qa_pub",
          caseId: seeded.caseId,
          kind: "ready",
          text: "Unverified replacement text",
        })
        await OrynService.drainOutbox()
        await OrynPublish.reconcileAllAmbiguous()
        expect(sent).toHaveLength(1)
      } finally {
        OrynService.setOutboxDeliverer(undefined)
      }
    })
  })

  test("queued readiness is suppressed after acceptance changes", async () => {
    await withPubScope(async (root) => {
      const seeded = await seedFrozen(root)
      await verifyFrozen(seeded)
      await OrynStore.attachRemoteRefs(seeded.caseId, { pullNumber: 55 })
      setTransport(
        fakeTransport({ candidateSha: seeded.candidateSha, marker: caseMarker(seeded.caseId), ci: "success" }),
      )
      await OrynPublish.publish({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        operation: "mark_ready",
        requestKey: "stale-ready",
      })
      const record = (await OrynStore.getCase(seeded.caseId))!
      await OrynStore.amendAcceptance(record.id, record.revision, { expected: "A changed acceptance target" })
      const sent: string[] = []
      OrynService.setOutboxDeliverer(async ({ text }) => {
        sent.push(text)
      })
      try {
        await OrynService.drainOutbox()
        await OrynPublish.reconcileAllAmbiguous()
        expect(sent).toEqual([])
        expect((await OrynStore.listPendingOutbox()).filter((entry) => entry.caseId === seeded.caseId)).toEqual([])
      } finally {
        OrynService.setOutboxDeliverer(undefined)
      }
    })
  })

  test("a new ready conclusion can notify after the previous conclusion was suppressed", async () => {
    await withPubScope(async (root) => {
      const seeded = await seedFrozen(root)
      await verifyFrozen(seeded)
      await OrynStore.attachRemoteRefs(seeded.caseId, { pullNumber: 55 })
      setTransport(
        fakeTransport({ candidateSha: seeded.candidateSha, marker: caseMarker(seeded.caseId), ci: "success" }),
      )
      const request = {
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        operation: "mark_ready" as const,
      }
      await OrynPublish.publish({ ...request, requestKey: "before-pause" })
      const record = (await OrynStore.getCase(seeded.caseId))!
      const paused = await OrynStore.control(record.id, record.revision, "pause")
      const sent: string[] = []
      OrynService.setOutboxDeliverer(async ({ text }) => {
        sent.push(text)
      })
      try {
        await OrynService.drainOutbox()
        expect(sent).toEqual([])
        await OrynStore.control(record.id, paused.revision, "resume")
        await OrynPublish.publish({ ...request, requestKey: "after-resume" })
        await OrynPublish.publish({ ...request, requestKey: "same-conclusion-another-request" })
        await OrynPublish.reconcileAllAmbiguous()
        expect(sent).toEqual([
          `Fix is ready for human review: https://github.com/acme/widget/pull/55 (candidate ${seeded.candidateSha})`,
        ])
      } finally {
        OrynService.setOutboxDeliverer(undefined)
      }
    })
  })

  test("takeover during transport readiness prevents the queued ready send", async () => {
    await withPubScope(async (root) => {
      const seeded = await seedFrozen(root)
      await verifyFrozen(seeded)
      await OrynStore.attachRemoteRefs(seeded.caseId, { pullNumber: 55 })
      setTransport(
        fakeTransport({ candidateSha: seeded.candidateSha, marker: caseMarker(seeded.caseId), ci: "success" }),
      )
      await OrynPublish.publish({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        operation: "mark_ready",
        requestKey: "before-takeover",
      })
      const sent: string[] = []
      OrynService.setOutboxDeliverer(
        async ({ text }) => {
          sent.push(text)
        },
        async () => {
          const record = (await OrynStore.getCase(seeded.caseId))!
          await OrynStore.control(record.id, record.revision, "takeover")
          return true
        },
      )
      try {
        await OrynService.drainOutbox()
        expect(sent).toEqual([])
        expect((await OrynStore.listPendingOutbox()).filter((entry) => entry.caseId === seeded.caseId)).toEqual([])
      } finally {
        OrynService.setOutboxDeliverer(undefined)
      }
    })
  })

  test("queued readiness waits for the current remote candidate and successful CI", async () => {
    await withPubScope(async (root) => {
      const seeded = await seedFrozen(root)
      await verifyFrozen(seeded)
      await OrynStore.attachRemoteRefs(seeded.caseId, { pullNumber: 55 })
      const facts = { candidateSha: seeded.candidateSha, marker: caseMarker(seeded.caseId), ci: "success" as const }
      setTransport(fakeTransport(facts))
      await OrynPublish.publish({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        operation: "mark_ready",
        requestKey: "remote-ready",
      })
      const sent: string[] = []
      OrynService.setOutboxDeliverer(async ({ text }) => {
        sent.push(text)
      })
      try {
        setTransport(fakeTransport({ ...facts, draft: false, pullHeadSha: "f".repeat(40) }))
        await OrynService.drainOutbox()
        expect(sent).toEqual([])
        setTransport(fakeTransport({ ...facts, draft: false, ci: "none" }))
        await OrynService.drainOutbox()
        expect(sent).toEqual([])
        setTransport(fakeTransport({ ...facts, draft: false }))
        await OrynService.drainOutbox()
        expect(sent).toHaveLength(1)
      } finally {
        OrynService.setOutboxDeliverer(undefined)
      }
    })
  })

  test.each(["delivered", "ambiguous"] as const)(
    "a legacy %s ready notice is not resent under a new request key",
    async (state) => {
      await withPubScope(async (root) => {
        const seeded = await seedFrozen(root)
        await verifyFrozen(seeded)
        const record = await OrynStore.attachRemoteRefs(seeded.caseId, { pullNumber: 55 })
        await OrynStore.writeAction({
          caseId: record.id,
          operation: "mark_ready",
          payloadDigest: "legacy-ready",
          expectedHead: seeded.candidateSha,
          expectedRevision: record.revision,
          epoch: record.epoch,
          requestKey: "legacy-ready",
          state: "acknowledged",
          readyTarget: {
            attemptId: seeded.attemptId,
            repository: "acme/widget",
            branch: orynBranch(record.id),
            baseBranch: "dev",
            deliveryCheck: false,
          },
          remoteRefs: { pullNumber: 55 },
        })
        setTransport(
          fakeTransport({
            candidateSha: seeded.candidateSha,
            marker: caseMarker(record.id),
            ci: "success",
            draft: false,
          }),
        )
        await OrynPublish.reconcileAllAmbiguous()
        const [notice] = (await OrynStore.listPendingOutbox()).filter((entry) => entry.caseId === record.id)
        expect(notice.dedupKey).toBe(`${record.id}:ready:${seeded.attemptId}`)
        await OrynStore.claimOutboxDelivery(notice.id)
        if (state === "delivered") await OrynStore.markOutboxDelivered(notice.id)
        const sent: string[] = []
        OrynService.setOutboxDeliverer(async ({ text }) => {
          sent.push(text)
        })
        try {
          await OrynPublish.publish({
            callerSessionID: seeded.engineeringSessionId,
            caseId: record.id,
            operation: "mark_ready",
            requestKey: "new-version-writer",
          })
          await OrynPublish.reconcileAllAmbiguous()
          expect(sent).toEqual([])
          expect((await OrynStore.listPendingOutbox()).filter((entry) => entry.caseId === record.id)).toEqual([])
        } finally {
          OrynService.setOutboxDeliverer(undefined)
        }
      })
    },
  )

  test("concurrent ready drains claim one physical notification", async () => {
    await withPubScope(async (root) => {
      const seeded = await seedFrozen(root)
      await verifyFrozen(seeded)
      await OrynStore.attachRemoteRefs(seeded.caseId, { pullNumber: 55 })
      setTransport(
        fakeTransport({ candidateSha: seeded.candidateSha, marker: caseMarker(seeded.caseId), ci: "success" }),
      )
      await OrynPublish.publish({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        operation: "mark_ready",
        requestKey: "concurrent-ready",
      })
      const sent: string[] = []
      OrynService.setOutboxDeliverer(async ({ text }) => {
        sent.push(text)
      })
      try {
        await Promise.all([OrynService.drainOutbox(), OrynService.drainOutbox(), OrynService.drainOutbox()])
        expect(sent).toHaveLength(1)
      } finally {
        OrynService.setOutboxDeliverer(undefined)
      }
    })
  })

  test("persists the bound PR before dispatch and delivers one ready result", async () => {
    await withPubScope(async (root) => {
      const seeded = await seedFrozen(root)
      await verifyFrozen(seeded)
      await OrynStore.attachRemoteRefs(seeded.caseId, { pullNumber: 55 })
      let executions = 0
      setTransport(
        fakeTransport({
          candidateSha: seeded.candidateSha,
          marker: caseMarker(seeded.caseId),
          ci: "success",
          async onExecute(call) {
            executions++
            expect(call.pullNumber).toBe(55)
            expect(call.body).toContain("```mermaid")
            expect(call.body).toContain("publication-fixture.txt")
            expect(call.body).toContain("candidate | passed | 0")
            expect(call.body).toContain("general: ready_for_human")
            expect(call.body).not.toContain(seeded.caseId)
            const actions = await OrynStore.listActions({ caseId: seeded.caseId })
            expect(actions[0]).toMatchObject({
              operation: "mark_ready",
              state: "in_flight",
              remoteRefs: { pullNumber: 55 },
            })
            return { refs: { pullNumber: 55 } }
          },
        }),
      )
      const request = {
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        operation: "mark_ready" as const,
        requestKey: "ready",
      }
      expect((await OrynPublish.publish(request)).state).toBe("acknowledged")
      expect((await OrynPublish.publish(request)).deduped).toBe(true)
      expect(executions).toBe(1)
      expect((await OrynStore.getAttempt(seeded.caseId, seeded.attemptId))?.disposition).toBe("ready")
      const outbox = (await OrynStore.listPendingOutbox()).filter(
        (entry) => entry.caseId === seeded.caseId && entry.kind === "ready",
      )
      expect(outbox).toHaveLength(1)
    })
  })

  test("a lost ready response reconciles without another mutation or notification", async () => {
    await withPubScope(async (root) => {
      const seeded = await seedFrozen(root)
      await verifyFrozen(seeded)
      await OrynStore.attachRemoteRefs(seeded.caseId, { pullNumber: 55 })
      setTransport(
        fakeTransport({
          candidateSha: seeded.candidateSha,
          marker: caseMarker(seeded.caseId),
          ci: "success",
          async onExecute() {
            const error = new Error("lost response")
            error.name = "GitHubApiError"
            throw error
          },
        }),
      )
      await expect(
        OrynPublish.publish({
          callerSessionID: seeded.engineeringSessionId,
          caseId: seeded.caseId,
          operation: "mark_ready",
          requestKey: "lost-ready",
          payload: `Verified fixture ${seeded.candidateSha}`,
        }),
      ).rejects.toThrow()
      const action = (await OrynStore.listActions({ caseId: seeded.caseId }))[0]!
      const transport = fakeTransport({
        candidateSha: seeded.candidateSha,
        marker: caseMarker(seeded.caseId),
        draft: false,
        ci: "success",
      })
      setTransport(transport)
      expect((await OrynPublish.reconcileAmbiguous(seeded.caseId, action.id)).state).toBe("acknowledged")
      expect((await OrynPublish.reconcileAmbiguous(seeded.caseId, action.id)).state).toBe("acknowledged")
      expect(transport.calls).toHaveLength(0)
      expect((await OrynStore.getAttempt(seeded.caseId, seeded.attemptId))?.disposition).toBe("ready")
      expect(
        (await OrynStore.listPendingOutbox()).filter(
          (entry) => entry.caseId === seeded.caseId && entry.kind === "ready",
        ),
      ).toHaveLength(1)
    })
  })

  test("refuses a model-selected PR outside the Case before calling the transport", async () => {
    await withPubScope(async (root) => {
      const seeded = await seedFrozen(root)
      await OrynStore.attachRemoteRefs(seeded.caseId, { pullNumber: 55 })
      const transport = fakeTransport({ candidateSha: seeded.candidateSha, marker: caseMarker(seeded.caseId) })
      setTransport(transport)
      try {
        await OrynPublish.publish({
          callerSessionID: seeded.engineeringSessionId,
          caseId: seeded.caseId,
          operation: "mark_ready",
          pullNumber: 99,
          requestKey: "foreign-ready",
        })
        expect.unreachable()
      } catch (error) {
        expect(errorCode(error)).toBe("NOT_AUTHORIZED")
      }
      expect(transport.calls).toHaveLength(0)
    })
  })
})

test("ready acknowledgement recovery finishes local effects without another remote action", async () => {
  await withPubScope(async (root) => {
    const seeded = await seedFrozen(root)
    await verifyFrozen(seeded)
    await OrynStore.attachRemoteRefs(seeded.caseId, { pullNumber: 55 })
    const record = (await OrynStore.getCase(seeded.caseId))!
    await OrynStore.writeAction({
      caseId: seeded.caseId,
      operation: "mark_ready",
      payloadDigest: "fixture",
      expectedHead: seeded.candidateSha,
      expectedRevision: record.revision,
      epoch: record.epoch,
      readyTarget: {
        attemptId: seeded.attemptId,
        repository: "acme/widget",
        branch: orynBranch(seeded.caseId),
        baseBranch: "dev",
        deliveryCheck: false,
      },
      requestKey: "ack-before-effects",
      state: "acknowledged",
      remoteRefs: { pullNumber: 55 },
    })
    const transport = fakeTransport({ candidateSha: seeded.candidateSha, marker: caseMarker(seeded.caseId) })
    setTransport(transport)
    await OrynPublish.reconcileAllAmbiguous()
    await OrynPublish.reconcileAllAmbiguous()
    expect(transport.calls).toHaveLength(0)
    expect((await OrynStore.getAttempt(seeded.caseId, seeded.attemptId))?.disposition).toBe("ready")
    expect(
      (await OrynStore.listPendingOutbox()).filter((entry) => entry.caseId === seeded.caseId && entry.kind === "ready"),
    ).toHaveLength(1)
  })
})

test("an acknowledged publication cannot ready a later attempt with the same SHA", async () => {
  await withPubScope(async (root) => {
    const seeded = await seedFrozen(root)
    await verifyFrozen(seeded)
    await OrynStore.attachRemoteRefs(seeded.caseId, { pullNumber: 55 })
    setTransport(fakeTransport({ candidateSha: seeded.candidateSha, marker: caseMarker(seeded.caseId), ci: "success" }))
    await OrynPublish.publish({
      callerSessionID: seeded.engineeringSessionId,
      caseId: seeded.caseId,
      operation: "mark_ready",
      requestKey: "old-attempt-ready",
      payload: `Verified ${seeded.candidateSha}`,
    })
    const rotated = await OrynStore.rotateAttempt({
      caseId: seeded.caseId,
      fromAttemptId: seeded.attemptId,
      invalidationReason: "new review required",
      nextBaselineSha: seeded.candidateSha,
      countRepair: true,
      countNoProgress: true,
    })
    await OrynStore.mutateAttempt(seeded.caseId, rotated.next.id, (attempt) => ({
      ...attempt,
      candidateSha: seeded.candidateSha,
    }))
    await OrynPublish.reconcileAllAmbiguous()
    expect((await OrynStore.getAttempt(seeded.caseId, rotated.next.id))?.disposition).toBe("open")
    const sent: string[] = []
    OrynService.setOutboxDeliverer(async ({ text }) => {
      sent.push(text)
    })
    try {
      await OrynService.drainOutbox()
      expect(sent).toEqual([])
      expect((await OrynStore.listPendingOutbox()).filter((entry) => entry.caseId === seeded.caseId)).toEqual([])
    } finally {
      OrynService.setOutboxDeliverer(undefined)
    }
  })
})

test("a label receipt cannot acknowledge a model publication through a reused request key", async () => {
  await withPubScope(async (root) => {
    const seeded = await seedFrozen(root)
    await OrynStore.writeAction({
      caseId: seeded.caseId,
      operation: "sync_labels",
      payloadDigest: "label-projection",
      expectedRevision: 0,
      epoch: 0,
      requestKey: "shared-request",
      state: "acknowledged",
      remoteRefs: { issueNumber: 12 },
    })
    await expect(
      OrynPublish.publish({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        operation: "ensure_issue",
        requestKey: "shared-request",
      }),
    ).rejects.toThrow("different publication operation")
  })
})

test("an expired candidate cannot publish readiness despite accepted verification and review", async () => {
  await withPubScope(async (root) => {
    const seeded = await seedFrozen(root)
    await verifyFrozen(seeded)
    await OrynStore.attachRemoteRefs(seeded.caseId, { pullNumber: 55 })
    const record = (await OrynStore.getCase(seeded.caseId))!
    await OrynStore.mutateCase(record.id, record.revision, (value) => ({
      ...value,
      createdAt: Date.now() - 721 * 60_000,
    }))
    const transport = fakeTransport({ candidateSha: seeded.candidateSha, marker: caseMarker(record.id), ci: "success" })
    setTransport(transport)
    const gate = await OrynService.evaluateDelivery({
      callerSessionID: seeded.engineeringSessionId,
      caseId: record.id,
      payload: `Verified candidate ${seeded.candidateSha}`,
      ciStatus: "passed",
    })
    expect(gate.ready).toBe(false)
    expect(gate.failures.some((failure) => failure.code === "BUDGET_EXHAUSTED")).toBe(true)
    await expect(
      OrynPublish.publish({
        callerSessionID: seeded.engineeringSessionId,
        caseId: record.id,
        operation: "mark_ready",
        requestKey: "expired-candidate-ready",
      }),
    ).rejects.toMatchObject({ data: { code: "BUDGET_EXHAUSTED" } })
    expect(transport.calls).toHaveLength(0)
  })
})

test("Host requires risk-domain reviews even when engineering only requested general review", async () => {
  await withPubScope(async (root) => {
    const seeded = await seedFrozen(root, ["src/channel/credentials/storage.ts", ".github/workflows/release.yml"])
    await verifyFrozen(seeded)
    const visible = await (
      await OrynCaseTool.init()
    ).execute(
      { input: { action: "get", caseId: seeded.caseId } },
      {
        sessionID: seeded.engineeringSessionId,
        messageID: "requirements",
        agent: "oryn-work",
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
      },
    )
    expect(JSON.parse(visible.output).reviewRequirements).toMatchObject({
      headSha: seeded.candidateSha,
      domains: ["general", "persistence", "security", "channel", "publishing"],
    })
    const gate = () =>
      OrynService.evaluateDelivery({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        payload: `Verified candidate ${seeded.candidateSha}`,
        ciStatus: "passed",
      })
    const missing = await gate()
    expect(missing.ready).toBe(false)
    for (const domain of ["persistence", "security", "channel", "publishing"] as const) {
      expect(missing.failures.some((failure) => failure.message.includes(domain))).toBe(true)
      const assignment = await OrynService.dispatch({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        stage: "review",
        requestKey: `risk-${domain}`,
        reviewDomain: domain,
      })
      await OrynService.submitReview({
        callerSessionID: assignment.workerSessionId,
        caseId: seeded.caseId,
        attemptId: seeded.attemptId,
        assignmentId: assignment.assignmentId,
        requestKey: `risk-report-${domain}`,
        headSha: seeded.candidateSha,
        baseSha: (await OrynStore.getAttempt(seeded.caseId, seeded.attemptId))!.baselineSha,
        domain,
        findings: [],
        evidenceAssessment: `Independent ${domain} evidence reviewed`,
        recommendation: "ready_for_human",
      })
    }
    expect(await gate()).toMatchObject({ ready: true, failures: [] })
    const reviews = (await OrynStore.listAssignments(seeded.caseId)).filter(
      (assignment) => assignment.stage === "review",
    )
    expect(new Set(reviews.map((assignment) => assignment.sessionId)).size).toBe(5)
  })
})

test("repair review requirements retain earlier sensitive changes in the cumulative PR diff", async () => {
  await withPubScope(async (root) => {
    const seeded = await seedFrozen(root, ["src/security/check.ts"])
    const initial = (await OrynStore.getAttempt(seeded.caseId, seeded.attemptId))!
    const next = await OrynService.rework({
      callerSessionID: seeded.engineeringSessionId,
      caseId: seeded.caseId,
      reason: "fix another part",
    })
    const worker = await OrynService.dispatch({
      callerSessionID: seeded.engineeringSessionId,
      caseId: seeded.caseId,
      stage: "code",
      requestKey: "repair-code",
    })
    const assignment = (await OrynStore.getAssignment(seeded.caseId, worker.assignmentId))!
    await Bun.write(`${assignment.workspaceRef}/ordinary.txt`, "repair\n")
    await Bun.$`git add -- ordinary.txt`.cwd(assignment.workspaceRef!).quiet()
    await Bun.$`git -c user.name=Fixture -c user.email=fixture@example.test commit -m "fix: repair ordinary behavior"`
      .cwd(assignment.workspaceRef!)
      .quiet()
    const head = await headSha(assignment.workspaceRef!)
    await OrynService.submitResult({
      callerSessionID: worker.workerSessionId,
      caseId: seeded.caseId,
      attemptId: next.attemptId,
      assignmentId: worker.assignmentId,
      requestKey: "repair-candidate",
      kind: "candidate",
      outcome: "candidate_ready",
      summary: "ordinary repair",
      candidateSha: head,
    })
    const attempt = (await OrynStore.getAttempt(seeded.caseId, next.attemptId))!
    expect(
      OrynReviewPolicy.classify(await OrynGit.changes(assignment.workspaceRef!, attempt.baselineSha, head)),
    ).toEqual(["general"])
    expect(await OrynReviewPolicy.requirements((await OrynStore.getCase(seeded.caseId))!, attempt)).toMatchObject({
      baseSha: initial.baselineSha,
      headSha: head,
      domains: ["general", "security"],
    })
  })
})

test("a previous policy's review stays stale and cannot resume or replay as a current assignment", async () => {
  await withPubScope(async (root) => {
    const seeded = await seedFrozen(root)
    await verifyFrozen(seeded)
    const assignment = (await OrynStore.listAssignments(seeded.caseId)).find((item) => item.stage === "review")!
    const record = (await OrynStore.getCase(seeded.caseId))!
    const attempt = (await OrynStore.getAttempt(seeded.caseId, seeded.attemptId))!
    const report = (await OrynStore.getReview(seeded.caseId, assignment.acceptedReportId!))!
    await Storage.write(OrynPath.assignment(seeded.caseId, assignment.id), {
      ...assignment,
      frozenInputsDigest: externalIdentityHash(
        attempt.baselineSha,
        attempt.candidateSha!,
        record.acceptanceDigest,
        "review",
      ),
    })
    await Storage.write(OrynPath.review(seeded.caseId, report.id), {
      ...report,
      policyDigest: externalIdentityHash(record.acceptanceDigest),
    })
    expect(await OrynControl.canRun(await Session.get(assignment.sessionId!))).toBe(false)
    await expect(
      OrynService.dispatch({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        stage: "review",
        requestKey: "ready-review",
      }),
    ).rejects.toMatchObject({ data: { code: "INVALID_STAGE" } })
    const gate = await OrynService.evaluateDelivery({
      callerSessionID: seeded.engineeringSessionId,
      caseId: seeded.caseId,
      payload: `Verified candidate ${seeded.candidateSha}`,
      ciStatus: "passed",
    })
    expect(gate.ready).toBe(false)
    expect(gate.failures).toContainEqual({ code: "STALE_HEAD", message: "general review snapshot is stale" })
    const fresh = await OrynService.dispatch({
      callerSessionID: seeded.engineeringSessionId,
      caseId: seeded.caseId,
      stage: "review",
      requestKey: "current-policy-review",
    })
    expect(fresh.workerSessionId).not.toBe(assignment.sessionId!)
    expect(
      await OrynService.submitReview({
        callerSessionID: fresh.workerSessionId,
        caseId: seeded.caseId,
        attemptId: seeded.attemptId,
        assignmentId: fresh.assignmentId,
        requestKey: "current-policy-report",
        headSha: seeded.candidateSha,
        baseSha: attempt.baselineSha,
        findings: [],
        evidenceAssessment: "Candidate reviewed under the current policy",
        recommendation: "ready_for_human",
      }),
    ).toMatchObject({ accepted: true, stale: false })
    expect(
      await OrynService.evaluateDelivery({
        callerSessionID: seeded.engineeringSessionId,
        caseId: seeded.caseId,
        payload: `Verified candidate ${seeded.candidateSha}`,
        ciStatus: "passed",
      }),
    ).toMatchObject({ ready: true, failures: [] })
  })
})
