import { describe, expect, test } from "bun:test"
import { Config } from "../../src/config/config"
import { OrynService } from "../../src/oryn/service"
import { OrynEngineering } from "../../src/oryn/engineering"
import { OrynPath } from "../../src/oryn/path"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { Identifier } from "../../src/id/id"
import { OrynStore } from "../../src/oryn/store"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { SessionManager } from "../../src/session/manager"
import { tmpdir } from "./fixture"

async function fixture(
  fn: (input: { qaId: string; directory: string; baseline: string; roots: string[] }) => Promise<void>,
) {
  await using repo = await tmpdir({ git: true })
  await using qa = await tmpdir({
    config: {
      oryn: {
        enabled: true,
        routes: [{ feishuAccount: "engineering-test", repoAlias: "fixture" }],
        repositories: { fixture: { owner: "test", repo: "fixture", directory: repo.path } },
      },
    },
  })
  await Bun.$`git remote add origin https://github.com/test/fixture.git`.cwd(repo.path).quiet()
  await Bun.$`git update-ref refs/remotes/origin/dev HEAD`.cwd(repo.path).quiet()
  const baseline = (await Bun.$`git rev-parse HEAD`.cwd(repo.path).text()).trim()
  const roots: string[] = []
  const leases: NonNullable<ReturnType<typeof SessionManager.acquire>>[] = []
  const create = Session.create
  try {
    Session.create = async (input) => {
      const session = await create(input)
      if (input?.agentOverride === "oryn-work") {
        roots.push(session.id)
        const lease = SessionManager.acquire(session.id)
        if (!lease) throw new Error("engineering fixture could not reserve root")
        leases.push(lease)
      }
      return session
    }
    await ScopeContext.provide({
      scope: await qa.scope(),
      fn: async () => {
        const session = await Session.create({ agentOverride: "oryn" })
        await OrynStore.bindSessionSource({
          sessionID: session.id,
          role: "qa",
          identity: { provider: "feishu", accountId: "engineering-test", chatId: qa.path, messageId: "question" },
        })
        await fn({ qaId: session.id, directory: repo.path, baseline, roots })
        await Session.remove(session.id)
      },
    })
  } finally {
    Session.create = create
    for (const id of roots) await SessionInbox.removeByMode(id, ["task", "steer", "context"])
    for (const lease of leases) await SessionManager.release(lease, { requestNextWork: false })
    for (const id of roots) await Session.remove(id)
  }
}

describe("Oryn automatic engineering startup", () => {
  test("an Attempt written before its Case link fails keeps the same identity on recovery", async () => {
    await fixture(async ({ qaId }) => {
      const write = Storage.write
      let interrupted = false
      try {
        Storage.write = async (key, value) => {
          if (
            !interrupted &&
            key[0] === "oryn" &&
            key.at(-1) === "info" &&
            value &&
            typeof value === "object" &&
            "activeAttemptId" in value &&
            value.activeAttemptId
          ) {
            interrupted = true
            throw new Error("injected attempt link interruption")
          }
          return write(key, value)
        }
        await expect(
          OrynService.submitCase({
            callerSessionID: qaId,
            requestKey: "attempt",
            kind: "bug",
            summary: "durable Attempt",
          }),
        ).rejects.toThrow("injected")
      } finally {
        Storage.write = write
      }
      const binding = await OrynStore.sessionSourceBinding(qaId)
      const record = (await OrynStore.listCasesForSource(binding!.sourceKey))[0]
      const start = (await OrynEngineering.get(record.id))!
      expect(start.attemptId).toBeDefined()
      expect(await OrynStore.getAttempt(record.id, start.attemptId!)).toBeDefined()
      const attempt = await OrynStore.getAttempt(record.id, start.attemptId!)
      await OrynEngineering.recover()
      expect((await OrynStore.getCase(record.id))?.activeAttemptId).toBe(start.attemptId)
      expect(await OrynStore.getAttempt(record.id, start.attemptId!)).toEqual(attempt)
      expect(await Storage.scan(OrynPath.attemptsRoot(record.id))).toHaveLength(1)
    })
  })

  test("recovers a Session whose creation stopped before its index was written", async () => {
    await fixture(async ({ qaId, roots }) => {
      const write = Storage.write
      let interrupted = false
      try {
        Storage.write = async (key, value) => {
          if (!interrupted && key[0] === "session_index") {
            interrupted = true
            throw new Error("injected index interruption")
          }
          return write(key, value)
        }
        await expect(
          OrynService.submitCase({
            callerSessionID: qaId,
            requestKey: "index",
            kind: "bug",
            summary: "recover creation index",
          }),
        ).rejects.toThrow("injected")
      } finally {
        Storage.write = write
      }
      const binding = await OrynStore.sessionSourceBinding(qaId)
      const record = (await OrynStore.listCasesForSource(binding!.sourceKey))[0]
      const start = (await OrynEngineering.get(record.id))!
      const infoPath = StoragePath.sessionInfo(
        Identifier.asScopeID(start.scopeId!),
        Identifier.asSessionID(start.sessionId),
      )
      await Storage.update<Session.Info>(infoPath, (info) => {
        info.title = "Preserve created Session"
      })
      // Reserve even an unindexed Session so recovery cannot launch a model in this fixture.
      const lease = SessionManager.acquire(start.sessionId)!
      try {
        await OrynEngineering.recover()
        expect((await Session.get(start.sessionId)).title).toBe("Preserve created Session")
        expect((await OrynStore.getCase(record.id))?.engineeringSessionId).toBe(start.sessionId)
      } finally {
        await SessionInbox.removeByMode(start.sessionId, ["task", "steer", "context"])
        await SessionManager.release(lease, { requestNextWork: false })
        if (!roots.includes(start.sessionId)) await Session.remove(start.sessionId)
      }
    })
  })

  test("recovers the reserved root after creation succeeds but Case binding fails", async () => {
    await fixture(async ({ qaId, roots }) => {
      const attach = OrynStore.attachEngineeringSession
      try {
        OrynStore.attachEngineeringSession = async () => {
          throw new Error("injected binding interruption")
        }
        await expect(
          OrynService.submitCase({
            callerSessionID: qaId,
            requestKey: "crash",
            kind: "bug",
            summary: "interrupted startup",
          }),
        ).rejects.toThrow("injected")
      } finally {
        OrynStore.attachEngineeringSession = attach
      }
      expect(roots).toHaveLength(1)
      const binding = await OrynStore.sessionSourceBinding(qaId)
      const record = (await OrynStore.listCasesForSource(binding!.sourceKey))[0]
      const before = await OrynEngineering.get(record.id)
      expect(before?.state).toBe("pending")
      expect(before?.sessionId).toBe(roots[0])
      await OrynEngineering.recover()
      expect((await OrynStore.getCase(record.id))?.engineeringSessionId).toBe(roots[0])
      expect((await OrynStore.incompleteClaims()).some((claim) => claim.caseId === record.id)).toBe(false)
      expect(roots).toHaveLength(1)
      expect(await SessionInbox.list(roots[0])).toHaveLength(1)
    })
  })

  test("recovery preserves the baseline across a moved remote-tracking branch and consumed task", async () => {
    await fixture(async ({ qaId, directory, baseline, roots }) => {
      const submitted = await OrynService.submitCase({
        callerSessionID: qaId,
        requestKey: "move",
        kind: "bug",
        summary: "baseline stays fixed",
      })
      await Bun.$`git -c user.name=Fixture -c user.email=fixture@example.invalid commit --allow-empty -m next`
        .cwd(directory)
        .quiet()
      await Bun.$`git update-ref refs/remotes/origin/dev HEAD`.cwd(directory).quiet()
      const start = await OrynEngineering.get(submitted.caseId)
      await Storage.write(OrynPath.engineeringStart(submitted.caseId), { ...start, state: "pending" })
      const item = (await SessionInbox.list(roots[0]))[0]
      await SessionInbox.materializeItem(item)
      await SessionInbox.commitReady(roots[0], [item.id])
      await OrynEngineering.recover()
      expect((await OrynEngineering.get(submitted.caseId))?.baselineSha).toBe(baseline)
      expect(roots).toHaveLength(1)
      expect(await SessionInbox.list(roots[0])).toHaveLength(0)
    })
  })

  test("a mismatched origin is durably blocked instead of using the QA checkout", async () => {
    await fixture(async ({ qaId, directory, roots }) => {
      await Bun.$`git remote set-url origin https://github.com/other/repo.git`.cwd(directory).quiet()
      const submitted = await OrynService.submitCase({
        callerSessionID: qaId,
        requestKey: "wrong-origin",
        kind: "bug",
        summary: "unavailable repository",
      })
      expect(submitted.engineering).toMatchObject({ state: "blocked", reason: "repository_origin_mismatch" })
      expect((await OrynEngineering.get(submitted.caseId))?.state).toBe("blocked")
      expect(roots).toHaveLength(0)
    })
  })

  test("cancellation during root creation prevents the initial task", async () => {
    await fixture(async ({ qaId, roots }) => {
      const attach = OrynStore.attachEngineeringSession
      try {
        OrynStore.attachEngineeringSession = async (caseId, sessionID) => {
          const record = await attach(caseId, sessionID)
          await OrynStore.control(caseId, record.revision, "cancel")
          return record
        }
        const submitted = await OrynService.submitCase({
          callerSessionID: qaId,
          requestKey: "cancel",
          kind: "bug",
          summary: "cancel before wake",
        })
        expect(submitted.engineering).toMatchObject({ state: "blocked", reason: "case_control_changed" })
        expect(await SessionInbox.list(roots[0])).toHaveLength(0)
      } finally {
        OrynStore.attachEngineeringSession = attach
      }
    })
  })

  test("accepts an explicit repository checkout in configuration", () => {
    expect(() =>
      Config.Info.parse({
        oryn: {
          enabled: true,
          routes: [{ feishuAccount: "test", repoAlias: "fixture" }],
          repositories: { fixture: { owner: "test", repo: "fixture", directory: "/trusted/fixture" } },
        },
      }),
    ).not.toThrow()
  })

  test("submitting a case starts one autonomous engineering root in the configured repository", async () => {
    await fixture(async ({ qaId, directory, baseline, roots }) => {
      const request = {
        callerSessionID: qaId,
        requestKey: "case",
        kind: "bug" as const,
        summary: "missing reply",
        expected: "one reply",
      }
      const submissions = await Promise.all([OrynService.submitCase(request), OrynService.submitCase(request)])
      expect(submissions[0].caseId).toBe(submissions[1].caseId)
      const record = await OrynStore.getCase(submissions[0].caseId)
      expect(record?.engineeringSessionId).toBeDefined()
      expect(roots).toHaveLength(1)
      const session = await Session.get(record!.engineeringSessionId!)
      expect(session.scope.id).not.toBe((await Session.get(qaId)).scope.id)
      expect(session.workspace?.path).toBe(directory)
      expect(session.controlProfile).toBe("autonomous")
      expect(session.workflow).toMatchObject({ kind: "boss", role: "boss" })
      expect(session.interaction?.mode).toBe("unattended")
      expect((await OrynStore.getAttempt(record!.id, record!.activeAttemptId!))?.baselineSha).toBe(baseline)
      const inbox = await SessionInbox.list(session.id)
      expect(inbox).toHaveLength(1)
      expect(JSON.stringify(inbox[0].message)).toContain("missing reply")
      expect(inbox[0].message?.metadata?.channelReply).toBeUndefined()
    })
  })
})
