import { describe, expect, test } from "bun:test"
import type { SynergyLinkBash, SynergyLinkProcess, SynergyLinkSession } from "@ericsanchezok/synergy-link-protocol"
import { SynergyLinkRemoteError } from "../../src/remote/client"
import { SynergyLinkExecution } from "../../src/tool/synergy-link-execution"
import path from "path"
import { LocalProcessBackend } from "../../src/tool/process/local"
import { ProcessTool } from "../../src/tool/process"
import { ProcessRegistry } from "../../src/process/registry"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "test",
  messageID: "message_test",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

describe("tool.process", () => {
  test("rejects removed envID instead of falling back to local process control", async () => {
    const process = await ProcessTool.init()
    expect(process.parameters.safeParse({ action: "list", envID: "legacy" }).success).toBe(false)
  })
  test("promotes finished process artifacts on poll", async () => {
    await using tmp = await tmpdir({ git: true })
    const filepath = path.join(tmp.path, "report.pdf")
    await Bun.write(filepath, "fake pdf")

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const proc = ProcessRegistry.create({
          command: "generate report",
          description: "Generate report",
          cwd: tmp.path,
        })
        ProcessRegistry.markBackgrounded(proc)
        ProcessRegistry.appendOutput(proc, `${filepath}\n`)
        ProcessRegistry.markExited(proc, 0, null)

        const process = await ProcessTool.init()
        const result = await process.execute(
          {
            action: "poll",
            processId: proc.id,
          },
          ctx,
        )

        expect(result.output).toContain("Process exited")
        expect(result.attachments).toHaveLength(1)
        expect(result.attachments?.[0].filename).toBe("report.pdf")
        expect(result.attachments?.[0].mime).toBe("application/pdf")

        ProcessRegistry.remove(proc.id)
      },
    })
  })

  test("clears a cached session after definitive invalid remote process execution", async () => {
    SynergyLinkExecution.setClient({
      executeBash: async (): Promise<SynergyLinkBash.Result> => {
        throw new Error("unexpected bash execution")
      },
      executeProcess: async (): Promise<SynergyLinkProcess.Result> => {
        throw new SynergyLinkRemoteError("session_not_found", "Session is not active.")
      },
      executeSession: async (): Promise<SynergyLinkSession.Result> => {
        throw new Error("unexpected session verification")
      },
    })
    SynergyLinkExecution.upsertSession({
      linkID: "link_invalid_process",
      targetAgentID: "agent_invalid_process",
      sourceAgent: "build",
      sessionID: "session_invalid_process",
      status: "opened",
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
      lastVerifiedAt: Date.now(),
    })
    try {
      const process = await ProcessTool.init()
      await expect(process.execute({ action: "list", linkID: "link_invalid_process" }, ctx)).rejects.toMatchObject({
        code: "session_not_found",
      })
      expect(SynergyLinkExecution.getSession("link_invalid_process")).toBeUndefined()
    } finally {
      SynergyLinkExecution.setClient(null)
    }
  })
})

test.each(["kill", "remove"] as const)("process %s waits for executor cleanup before returning", async (action) => {
  const proc = ProcessRegistry.create({ sessionID: "owned-worker", command: "controlled-process" })
  ProcessRegistry.markBackgrounded(proc)
  const terminated = Promise.withResolvers<void>()
  const completed = Promise.withResolvers<void>()
  ProcessRegistry.setTerminator(proc, () => {
    terminated.resolve()
  })
  ProcessRegistry.setCompletion(proc, completed.promise)
  let returned = false
  const result = LocalProcessBackend.execute({ action, processId: proc.id }).then((value) => {
    returned = true
    return value
  })
  try {
    await terminated.promise
    await Bun.sleep(0)
    expect(returned).toBe(false)
    expect(ProcessRegistry.get(proc.id)).toBe(proc)
    ProcessRegistry.markExited(proc, null, "SIGTERM")
    expect(ProcessRegistry.getFinished(proc.id)?.sessionID).toBe("owned-worker")
    completed.resolve()
    await result
    expect(returned).toBe(true)
    if (action === "remove") expect(ProcessRegistry.getFinished(proc.id)).toBeUndefined()
  } finally {
    completed.resolve()
    await result
    ProcessRegistry.remove(proc.id)
  }
})
