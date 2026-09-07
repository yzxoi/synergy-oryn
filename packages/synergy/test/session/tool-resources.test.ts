import { describe, expect, test } from "bun:test"
import { jsonSchema, type Tool as AITool } from "ai"
import { SessionProcessor } from "../../src/session/processor"
import { ToolTaskScheduler, ToolScheduler, type ToolTaskInput } from "../../src/session/tool-scheduler"

function fixture() {
  const scheduler = new ToolTaskScheduler({ maxConcurrent: 2, maxQueued: 8, executorConcurrency: { local_process: 2 } })
  const slots = new Map<string, SessionProcessor.ToolExecutionSlot>()
  const started: string[] = []
  const releases: Array<() => void> = []
  const pending: Promise<unknown>[] = []
  const processor = {
    message: { id: "resource-fixture" },
    beginExecution(id: string) {
      if (!slots.has(id)) slots.set(id, SessionProcessor.createSlot(id))
      return slots.get(id)!
    },
  }
  function dispatch(id: string, profile: string, signal = new AbortController().signal) {
    const barrier = Promise.withResolvers<void>()
    releases.push(barrier.resolve)
    const input: ToolTaskInput = {
      sessionID: `session-${id}`,
      generation: 1,
      messageID: "resource-fixture",
      callID: id,
      toolName: "fixture",
      executor: "local_process",
      input: {},
      processor,
      signal,
      resources: [
        { key: "heavy", limit: 2 },
        { key: profile, limit: 1 },
      ],
      tool: {
        inputSchema: jsonSchema({ type: "object" }),
        execute: async () => {
          started.push(id)
          await barrier.promise
          processor.beginExecution(id).complete({}, { title: id, output: id, metadata: {} })
        },
      } satisfies AITool,
    }
    const task = scheduler.dispatch(input)
    pending.push(task)
    return { task, release: barrier.resolve }
  }
  return {
    scheduler,
    started,
    dispatch,
    async [Symbol.asyncDispose]() {
      releases.forEach((release) => release())
      await Promise.all(pending)
      await scheduler.stop()
    },
  }
}

describe("ToolScheduler resource admission", () => {
  test("acquires all quotas together without occupying capacity while a profile is busy", async () => {
    await using f = fixture()
    f.dispatch("a1", "profile-a")
    f.dispatch("a2", "profile-a")
    f.dispatch("b1", "profile-b")
    expect(f.started).toEqual(["a1", "b1"])
    expect(f.scheduler.stats()).toMatchObject({ active: 2, queued: 1 })
  })

  test("cancels a resource waiter without invoking it and resumes the next eligible task", async () => {
    await using f = fixture()
    const first = f.dispatch("first", "profile-a")
    const controller = new AbortController()
    const cancelled = f.dispatch("cancel", "profile-a", controller.signal)
    const next = f.dispatch("next", "profile-a")
    controller.abort()
    expect((await cancelled.task).state).toBe("cancelled")
    expect(f.started).toEqual(["first"])
    first.release()
    await first.task
    // Let the scheduler release its completed task before the next assertion.
    await Promise.resolve()
    expect(f.started).toEqual(["first", "next"])
    next.release()
  })

  test("returns an execution lease only inside the admitted callback", async () => {
    const scheduler = new ToolTaskScheduler({ maxConcurrent: 1, maxQueued: 1 })
    const slot = SessionProcessor.createSlot("lease")
    expect(ToolScheduler.currentExecution()).toBeUndefined()
    await scheduler.dispatch({
      sessionID: "session-lease",
      generation: 1,
      messageID: "message",
      callID: "lease",
      toolName: "fixture",
      executor: "local_process",
      input: {},
      signal: new AbortController().signal,
      resources: [{ key: "heavy", limit: 1 }],
      processor: { message: { id: "message" }, beginExecution: () => slot },
      tool: {
        inputSchema: jsonSchema({ type: "object" }),
        execute: async () => {
          expect(ToolScheduler.currentExecution()).toMatchObject({
            sessionID: "session-lease",
            executor: "local_process",
            resources: [{ key: "heavy", limit: 1 }],
          })
          slot.complete({}, { title: "done", output: "done", metadata: {} })
        },
      } satisfies AITool,
    })
    expect(ToolScheduler.currentExecution()).toBeUndefined()
    await scheduler.stop()
  })
})

test("tool completion retains capacity until tracked physical execution settles", async () => {
  const scheduler = new ToolTaskScheduler({ maxConcurrent: 1, maxQueued: 2 })
  const physical = Promise.withResolvers<void>()
  const returned = Promise.withResolvers<void>()
  const slot = SessionProcessor.createSlot("physical")
  const nextSlot = SessionProcessor.createSlot("next")
  let nextStarted = false
  const first = scheduler.dispatch({
    sessionID: "physical-session",
    generation: 1,
    messageID: "message",
    callID: "physical",
    toolName: "fixture",
    executor: "local_process",
    resources: [{ key: "heavy", limit: 1 }],
    input: {},
    signal: new AbortController().signal,
    processor: { message: { id: "message" }, beginExecution: () => slot },
    tool: {
      inputSchema: jsonSchema({ type: "object" }),
      execute: async () => {
        ToolScheduler.trackPhysicalExecution(() => physical.promise)
        slot.complete({}, { title: "logical completion", output: "done", metadata: {} })
        returned.resolve()
      },
    } satisfies AITool,
  })
  const next = scheduler.dispatch({
    sessionID: "next-session",
    generation: 1,
    messageID: "message",
    callID: "next",
    toolName: "fixture",
    executor: "local_process",
    resources: [{ key: "heavy", limit: 1 }],
    input: {},
    signal: new AbortController().signal,
    processor: { message: { id: "message" }, beginExecution: () => nextSlot },
    tool: {
      inputSchema: jsonSchema({ type: "object" }),
      execute: async () => {
        nextStarted = true
        nextSlot.complete({}, { title: "next", output: "next", metadata: {} })
      },
    } satisfies AITool,
  })
  try {
    await returned.promise
    await Promise.resolve()
    expect(nextStarted).toBe(false)
    expect(scheduler.stats()).toMatchObject({ active: 1, queued: 1 })
    physical.resolve()
    await Promise.all([first, next])
    expect(nextStarted).toBe(true)
  } finally {
    physical.resolve()
    await Promise.all([first, next])
    await scheduler.stop()
  }
})

test("physical execution cannot start outside an admitted callback", () => {
  let started = false
  expect(() =>
    ToolScheduler.trackPhysicalExecution(async () => {
      started = true
    }),
  ).toThrow("active tool admission")
  expect(started).toBe(false)
})
