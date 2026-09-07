import { jsonSchema, type Tool as AITool } from "ai"
import { OrynService } from "../../src/oryn/service"
import { registerOrynDomain } from "../../src/oryn/register"
import { SessionProcessor } from "../../src/session/processor"
import { ToolExecutor } from "../../src/session/tool-executor"
import { ToolTaskScheduler } from "../../src/session/tool-scheduler"
import { Config } from "../../src/config/config"
import { ConfigDomain } from "../../src/config/domain"
import { Lock } from "../../src/util/lock"
import { tmpdir as projectTmpdir } from "../fixture/fixture"

export async function globalConfig(config: Partial<Config.Info>) {
  const lock = await Lock.write("test-oryn-global-config")
  const saved: Array<{ id: ConfigDomain.Id; config: Config.Info }> = []
  const restore = async () => {
    try {
      for (const entry of saved.reverse()) await Config.domainUpdate(entry.id, entry.config, { mode: "replace-domain" })
    } finally {
      lock[Symbol.dispose]()
    }
  }
  try {
    for (const [id, fragment] of ConfigDomain.split(config)) {
      const previous = await Config.domainGet(id)
      saved.push({ id, config: previous })
      await Config.domainUpdate(id, { ...previous, ...fragment }, { mode: "replace-domain" })
    }
    return { [Symbol.asyncDispose]: restore }
  } catch (error) {
    await restore()
    throw error
  }
}

export async function tmpdir<T>(options?: Parameters<typeof projectTmpdir<T>>[0]) {
  if (!options?.config?.oryn) return projectTmpdir(options)
  const { oryn, ...projectConfig } = options.config
  const global = await globalConfig({ oryn })
  try {
    const fixture = await projectTmpdir({ ...options, config: projectConfig })
    return {
      ...fixture,
      [Symbol.asyncDispose]: async () => {
        try {
          await fixture[Symbol.asyncDispose]()
        } finally {
          await global[Symbol.asyncDispose]()
        }
      },
    }
  } catch (error) {
    await global[Symbol.asyncDispose]()
    throw error
  }
}

const checkScheduler = new ToolTaskScheduler({ maxConcurrent: 4, maxQueued: 16 })

export async function runBaseline(input: {
  callerSessionID: string
  caseId: string
  attemptId: string
  assignmentId: string
  profileId?: string
  exitCode?: number
}) {
  const { profileId = "quick", exitCode = 1, ...worker } = input
  const plan = await OrynService.proposeCheck({
    ...worker,
    scenario: "fixture process outcome for report ownership tests",
    profileId,
    argv: [["bun", "--print", `process.exit(${exitCode})`]],
    checks: ["fixture process exits with the selected code"],
  })
  const run = await runCheck({
    ...worker,
    planId: plan.planId,
    lane: "baseline",
    abort: new AbortController().signal,
  })
  if (run.outcome !== (exitCode ? "failed" : "passed")) {
    throw new Error(`fixture baseline did not execute: ${run.outcome}`)
  }
  return run.runId
}

export async function runCheck(request: Parameters<typeof OrynService.runCheck>[0]) {
  registerOrynDomain()
  const { callerSessionID, abort, ...params } = request
  const input = { input: { action: "run", ...params } }
  const admission = await ToolExecutor.admission({
    toolName: "oryn_check",
    executor: ToolExecutor.classify("oryn_check"),
    sessionID: callerSessionID,
    input,
    signal: abort,
  })
  const callID = `check-${crypto.randomUUID()}`
  const slot = SessionProcessor.createSlot(callID)
  let output: Awaited<ReturnType<typeof OrynService.runCheck>> | undefined
  let failure: unknown
  const result = await checkScheduler.dispatch({
    sessionID: callerSessionID,
    generation: 1,
    messageID: "fixture-check",
    callID,
    toolName: "oryn_check",
    ...admission,
    input,
    signal: abort,
    processor: { message: { id: "fixture-check" }, beginExecution: () => slot },
    tool: {
      inputSchema: jsonSchema({ type: "object" }),
      execute: async (_input, options) => {
        try {
          output = await OrynService.runCheck({ ...request, abort: options.abortSignal ?? abort })
          slot.complete(input, { title: "check", output: JSON.stringify(output), metadata: output })
        } catch (error) {
          failure = error
          throw error
        }
      },
    } satisfies AITool,
  })
  if (result.state !== "completed" || !output) throw failure ?? new Error(result.error ?? "check did not complete")
  return output
}
