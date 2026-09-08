import { expect, test } from "bun:test"
import { OrynStore, sourceKey } from "../../src/oryn/store"
import { OrynService } from "../../src/oryn/service"
import { Storage } from "../../src/storage/storage"
import { OrynPath } from "../../src/oryn/path"
import { tmpdir } from "./fixture"
import { ScopeContext } from "../../src/scope/context"
import { Config } from "../../src/config/config"

async function fixture(
  fn: (input: { caseId: string; rootID: string; qaID: string; source: string; sent: string[] }) => Promise<void>,
) {
  await using tmp = await tmpdir({
    config: {
      oryn: {
        enabled: true,
        routes: [{ feishuAccount: "handoff", chats: ["qa"], repoAlias: "fixture" }],
        repositories: { fixture: { owner: "acme", repo: "fixture" } },
      },
    },
  })
  return await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const qaID = `qa_${crypto.randomUUID()}`
      const rootID = `root_${crypto.randomUUID()}`
      const identity = {
        provider: "feishu" as const,
        accountId: "handoff",
        chatId: "qa",
        threadId: qaID,
        messageId: "report",
      }
      const source = sourceKey(identity)
      await OrynStore.bindSessionSource({ sessionID: qaID, identity, role: "qa" })
      await OrynStore.recordChannelTurn({ sessionID: qaID, rootID: "turn", identity, chatType: "group" })
      const record = await OrynStore.createCase({
        caseId: `case_${crypto.randomUUID()}`,
        kind: "bug",
        summary: "Attachment missing",
        repoAlias: "fixture",
        sourceKeyHash: source,
      })
      await OrynStore.linkSourceToCase(source, record.id)
      await OrynStore.attachEngineeringSession(record.id, rootID)
      await OrynStore.bindSessionSource({ sessionID: rootID, identity, caseId: record.id, role: "engineering" })
      const sent: string[] = []
      OrynService.setOutboxDeliverer(async ({ identity, text }) => {
        if (identity.threadId === qaID) sent.push(text)
      })
      try {
        await fn({ caseId: record.id, rootID, qaID, source, sent })
      } finally {
        OrynService.setOutboxDeliverer(undefined)
      }
    },
  })
}

test("engineering handoff persists its reason, sends once, and QA cannot duplicate that lifecycle notification", async () => {
  await fixture(async ({ caseId, rootID, qaID, sent }) => {
    const first = await OrynService.requestHandoff({
      callerSessionID: rootID,
      caseId,
      reason: "Need the failing attachment and client version",
    })
    expect(first.control).toBe("human_owned")
    expect(first.handoff).toMatchObject({
      reason: "Need the failing attachment and client version",
      epoch: first.epoch,
    })
    expect(sent).toEqual(["Oryn needs human input: Need the failing attachment and client version"])
    const repeated = await OrynService.requestHandoff({
      callerSessionID: rootID,
      caseId,
      reason: "Need the failing attachment and client version",
    })
    expect(repeated).toEqual(first)
    await OrynService.reply({
      callerSessionID: qaID,
      turnID: "turn",
      caseId,
      kind: "needs_human",
      text: "Duplicate notice",
    })
    await OrynService.drainOutbox()
    expect(sent).toHaveLength(1)
    await expect(
      OrynService.requestHandoff({ callerSessionID: rootID, caseId, reason: "Override human ownership" }),
    ).rejects.toMatchObject({ data: { code: "HUMAN_OWNED" } })
  })
})

test("handoff recovery repairs the gap after Case persistence and deduplicates repeated recovery", async () => {
  await fixture(async ({ caseId, rootID, sent }) => {
    const write = OrynStore.writeOutbox
    try {
      OrynStore.writeOutbox = async (input) => {
        if (input.caseId === caseId) throw new Error("fixture interrupted outbox write")
        return write(input)
      }
      await expect(
        OrynService.requestHandoff({ callerSessionID: rootID, caseId, reason: "Need target platform" }),
      ).rejects.toThrow("fixture interrupted")
    } finally {
      OrynStore.writeOutbox = write
    }
    expect((await OrynStore.getCase(caseId))?.handoff?.reason).toBe("Need target platform")
    await OrynService.recoverHandoffs()
    expect(sent).toEqual(["Oryn needs human input: Need target platform"])
    await OrynService.recoverHandoffs()
    expect(sent).toHaveLength(1)
  })
})

test("queued handoff does not send after the source is unlinked", async () => {
  await fixture(async ({ caseId, rootID, source, sent }) => {
    OrynService.setOutboxDeliverer(undefined)
    await OrynService.requestHandoff({ callerSessionID: rootID, caseId, reason: "Need a sample" })
    const record = (await OrynStore.getCase(caseId))!
    await Storage.write(OrynPath.caseInfo(caseId), { ...record, sourceIds: [] })
    OrynService.setOutboxDeliverer(async ({ text }) => {
      sent.push(text)
    })
    await OrynService.drainOutbox()
    expect(sent).toEqual([])
    expect(
      (await OrynStore.listPendingOutbox()).some((entry) => entry.caseId === caseId && entry.sourceKey === source),
    ).toBe(false)
  })
})

test("handoff recovery never resends when the transport accepted a notification but lost its response", async () => {
  await fixture(async ({ caseId, rootID, sent }) => {
    OrynService.setOutboxDeliverer(async ({ text }) => {
      sent.push(text)
      throw new Error("fixture lost response after remote acceptance")
    })
    const input = { callerSessionID: rootID, caseId, reason: "Need the failing sample" }
    await OrynService.requestHandoff(input)
    await OrynService.requestHandoff(input)
    await OrynService.recoverHandoffs()
    expect(sent).toEqual(["Oryn needs human input: Need the failing sample"])
    expect((await OrynStore.listPendingOutbox()).some((entry) => entry.caseId === caseId)).toBe(false)
  })
})

test("resuming a Case suppresses an unsent handoff and a later handoff gets its own notification", async () => {
  await fixture(async ({ caseId, rootID, sent }) => {
    OrynService.setOutboxDeliverer(undefined)
    const first = await OrynService.requestHandoff({ callerSessionID: rootID, caseId, reason: "Need a sample" })
    await OrynStore.control(caseId, first.revision, "resume")
    OrynService.setOutboxDeliverer(async ({ text }) => {
      sent.push(text)
    })
    await OrynService.drainOutbox()
    expect(sent).toEqual([])
    const next = await OrynService.requestHandoff({ callerSessionID: rootID, caseId, reason: "Need a sample" })
    expect(next.epoch).toBe(first.epoch + 1)
    expect(sent).toEqual(["Oryn needs human input: Need a sample"])
    await OrynService.recoverHandoffs()
    expect(sent).toHaveLength(1)
  })
})

test("notification policy suppresses handoff delivery while preserving the operator reason", async () => {
  await fixture(async ({ caseId, rootID, sent }) => {
    const config = await Config.globalRaw()
    await Config.domainUpdate("runtime", { oryn: { ...config.oryn, notifications: { kinds: ["answer"] } } })
    const record = await OrynService.requestHandoff({ callerSessionID: rootID, caseId, reason: "Need a sample" })
    expect(record.handoff?.reason).toBe("Need a sample")
    expect(sent).toEqual([])
    expect((await OrynStore.listPendingOutbox()).some((entry) => entry.caseId === caseId)).toBe(false)
  })
})

test("handoff fanout reaches each linked reporter once and excludes unrelated conversations", async () => {
  await fixture(async ({ caseId, rootID, qaID }) => {
    for (const linked of [true, false]) {
      const sessionID = `qa_${crypto.randomUUID()}`
      const identity = {
        provider: "feishu" as const,
        accountId: "handoff",
        chatId: "qa",
        threadId: sessionID,
        messageId: "report",
      }
      await OrynStore.bindSessionSource({ sessionID, identity, role: "qa" })
      await OrynStore.recordChannelTurn({ sessionID, rootID: "turn", identity, chatType: "group" })
      if (linked) await OrynStore.linkSourceToCase(sourceKey(identity), caseId)
    }
    const recipients: string[] = []
    OrynService.setOutboxDeliverer(async ({ identity }) => {
      recipients.push(identity.threadId!)
    })
    await OrynService.requestHandoff({ callerSessionID: rootID, caseId, reason: "Need a sample" })
    await OrynService.recoverHandoffs()
    expect(recipients).toHaveLength(2)
    expect(new Set(recipients).size).toBe(2)
    expect(recipients).toContain(qaID)
  })
})
