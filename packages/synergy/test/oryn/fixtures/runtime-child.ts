import "../../../src/product-registration"
import { z } from "zod"
import { Config } from "../../../src/config/config"
import { ConfigDomain } from "../../../src/config/domain"
import { Global } from "../../../src/global"
import { Log } from "../../../src/util/log"
import { Scope } from "../../../src/scope"
import { ScopeContext } from "../../../src/scope/context"
import { RuntimeHandle } from "../../../src/server/runtime-handle"
import { Channel } from "../../../src/channel"
import { registerProviders } from "../../../src/channel/provider"
import { setTransport } from "../../../src/oryn/publish"
import { ActionReceipt } from "../../../src/oryn/schema"
import { OrynStore } from "../../../src/oryn/store"
import { Session } from "../../../src/session"
import { SessionManager } from "../../../src/session/manager"
import { AgentTurn } from "../../../src/session/agent-turn"
import { mockFeishu } from "./feishu"
import { RuntimeCommand } from "./runtime-protocol"

if (!process.send || !process.env.SYNERGY_TEST_HOME || process.env.SYNERGY_HOME !== process.env.SYNERGY_TEST_HOME)
  throw new Error("Runtime fixture requires an isolated home and IPC")
const boot = z.object({ config: Config.Info, broker: z.string().url() }).parse(await Bun.file(process.argv[2]).json())
const ordinaryFetch = globalThis.fetch
const localFetch: typeof fetch = Object.assign(
  async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw new Error("Runtime fixture blocks external fetch")
    return ordinaryFetch(input, init)
  },
  { preconnect: ordinaryFetch.preconnect },
)
globalThis.fetch = localFetch
await Global.initialize()
await Log.init({ print: false, dev: true, level: "DEBUG" })
for (const [id, fragment] of ConfigDomain.split(boot.config))
  await Config.domainUpdate(id, fragment, { mode: "replace-domain" })

async function broker(operation: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(boot.broker, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation, input }),
    signal,
  })
  if (!response.ok) throw new Error(`Mock broker failed: ${await response.text()}`)
  return response.json()
}
registerProviders()
const feishu = mockFeishu()
feishu.provider.conversation!.replyMessage = async (input) =>
  z.object({ messageId: z.string() }).parse(await broker("feishu.reply", input))
Channel.registerProvider(feishu.provider)
const ExecuteResult = z.object({ refs: ActionReceipt.shape.remoteRefs.unwrap() })
const Facts = z.object({
  issue: z
    .object({
      number: z.number(),
      title: z.string(),
      state: z.string(),
      markerPresent: z.boolean(),
      authorIsApp: z.boolean(),
    })
    .optional(),
  pull: z
    .object({
      number: z.number(),
      title: z.string(),
      headSha: z.string(),
      draft: z.boolean().optional(),
      headBranch: z.string(),
      baseRef: z.string(),
      state: z.string(),
      markerPresent: z.boolean(),
      authorIsApp: z.boolean(),
    })
    .optional(),
  delivery: z.object({ checkRunId: z.number(), headSha: z.string() }).optional(),
  ci: z.object({ state: z.enum(["success", "failure", "pending", "none"]) }),
})
setTransport({
  execute: async (input, signal) => ExecuteResult.parse(await broker("github.execute", input, signal)),
  observe: async (input, signal) => Facts.parse(await broker("github.observe", input, signal)),
})
const runtime = await RuntimeHandle.open({
  mode: "server",
  network: { hostname: "127.0.0.1", port: 0 },
  migrationOutput: "silent",
})
process.send({ event: "ready", pid: process.pid, port: runtime.server.port })
process.on("message", (raw: unknown) => {
  void (async () => {
    const command = RuntimeCommand.parse(raw)
    try {
      const result = await ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          if (command.operation === "receive") {
            const host = await feishu.connected()
            const result = await host.conversations.receive(command.message)
            if (result.accepted) await result.execution
            return { accepted: result.accepted }
          }
          if (command.operation === "stop") {
            await runtime.close()
            return { stopped: true }
          }
          const cases = await OrynStore.listCases({ repoAlias: "fixture" })
          const assignments = (await Promise.all(cases.map((record) => OrynStore.listAssignments(record.id)))).flat()
          const ids = new Set([
            ...cases.flatMap((record) => (record.engineeringSessionId ? [record.engineeringSessionId] : [])),
            ...assignments.flatMap((item) => (item.sessionId ? [item.sessionId] : [])),
          ])
          const sessions = await Promise.all(
            [...ids].map(async (id) => {
              const session = await SessionManager.getSession(id)
              return {
                id,
                exists: !!session,
                roots: (session ? await Session.messages({ sessionID: id }) : [])
                  .filter((message) => message.info.role === "user" && message.info.isRoot)
                  .map((message) => message.info.id),
                running: SessionManager.isRunning(id),
                workspace: session?.workspace?.path,
              }
            }),
          )
          return {
            pid: process.pid,
            cases,
            assignments,
            attempts: (await Promise.all(cases.map((record) => OrynStore.listAttempts(record.id)))).flat(),
            runs: (await Promise.all(cases.map((record) => OrynStore.listRuns(record.id)))).flat(),
            reviews: (await Promise.all(cases.map((record) => OrynStore.listReviews(record.id)))).flat(),
            reports: (await Promise.all(cases.map((record) => OrynStore.listWorkerReports(record.id)))).flat(),
            actions: (await Promise.all(cases.map((record) => OrynStore.listActions({ caseId: record.id })))).flat(),
            sessions,
            agents: AgentTurn.stats(),
            reactions: feishu.reactions.length,
            streaming: feishu.streamingCalls.length,
          }
        },
      })
      process.send!({ id: command.id, result })
      if (command.operation === "stop") setTimeout(() => process.exit(0), 10)
    } catch (error) {
      process.send!({
        id: command.id,
        error: `${command.operation}: ${error instanceof Error ? error.stack : String(error)}`,
      })
    }
  })().catch((error) => {
    process.send!({ event: "fatal", error: String(error) })
    process.exitCode = 1
  })
})
