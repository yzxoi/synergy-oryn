import { spawn } from "node:child_process"
import { copyFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { RuntimeMessage, RuntimeSnapshot } from "./runtime-protocol"

export async function runtimeProcess(input: { home: string; boot: string }) {
  await mkdir(path.join(input.home, "tmp"), { recursive: true })
  if (process.platform === "linux") {
    const helper = path.resolve(
      import.meta.dir,
      "../../../src/sandbox/helper-linux/target/release/synergy-sandbox-linux",
    )
    if (await Bun.file(helper).exists()) {
      const destination = path.join(input.home, ".synergy/sandbox-helper")
      await mkdir(destination, { recursive: true })
      await copyFile(helper, path.join(destination, "synergy-sandbox-linux"))
    }
  }
  const ready = Promise.withResolvers<{ pid: number; port: number }>()
  const closed = Promise.withResolvers<void>()
  const pending = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>()
  let output = ""
  let ended = false
  const child = spawn(
    process.execPath,
    ["--conditions=browser", path.join(import.meta.dir, "runtime-child.ts"), input.boot],
    {
      cwd: path.resolve(import.meta.dir, "../../.."),
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        PATH: process.env.PATH,
        HOME: input.home,
        TMPDIR: path.join(input.home, "tmp"),
        SYNERGY_HOME: input.home,
        SYNERGY_TEST_HOME: input.home,
        SYNERGY_OBSERVABILITY_INLINE: "1",
        MODELS_DEV_API_JSON: path.resolve(import.meta.dir, "../../tool/fixtures/models-api.json"),
        SYNERGY_DISABLE_MODELS_FETCH: "true",
        SYNERGY_DISABLE_DEFAULT_PLUGINS: "true",
        SYNERGY_DISABLE_LSP_DOWNLOAD: "true",
        SYNERGY_DISABLE_FILEWATCHER: "true",
        SYNERGY_DISABLE_BUILTIN_MCP: "true",
      },
    },
  )
  for (const stream of [child.stdout, child.stderr])
    stream!.on("data", (chunk) => {
      output = (output + String(chunk)).slice(-65536)
    })
  const Envelope = z.object({
    id: z.string().optional(),
    event: z.string().optional(),
    pid: z.number().optional(),
    port: z.number().optional(),
    error: z.string().optional(),
    result: z.unknown().optional(),
  })
  child.on("message", (raw: unknown) => {
    const message = Envelope.parse(raw)
    if (message.event === "ready") ready.resolve({ pid: message.pid!, port: message.port! })
    if (message.event === "fatal") ready.reject(new Error(message.error))
    if (!message.id) return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(message.error))
    else request.resolve(message.result)
  })
  child.on("error", (error) => ready.reject(error))
  child.on("close", (code, signal) => {
    ended = true
    const error = new Error(`Runtime fixture exited (${code ?? signal}): ${output.slice(-6000)}`)
    ready.reject(error)
    for (const request of pending.values()) request.reject(error)
    pending.clear()
    closed.resolve()
  })
  async function crash() {
    if (!ended && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      }
    }
    await closed.promise
  }
  async function request(operation: "receive" | "snapshot" | "stop", message?: z.infer<typeof RuntimeMessage>) {
    if (ended) throw new Error(`Runtime fixture is closed: ${output.slice(-6000)}`)
    const id = crypto.randomUUID()
    const result = Promise.withResolvers<unknown>()
    pending.set(id, result)
    const timeout = setTimeout(() => {
      pending.delete(id)
      result.reject(new Error(`Runtime fixture ${operation} timed out: ${output.slice(-6000)}`))
    }, 30000)
    child.send({ id, operation, ...(message ? { message } : {}) })
    try {
      return await result.promise
    } finally {
      clearTimeout(timeout)
    }
  }
  const timeout = setTimeout(
    () => ready.reject(new Error(`Runtime fixture startup timed out: ${output.slice(-6000)}`)),
    45000,
  )
  try {
    const started = await ready.promise
    return {
      ...started,
      receive: async (message: z.infer<typeof RuntimeMessage>) =>
        z.object({ accepted: z.boolean() }).parse(await request("receive", message)),
      snapshot: async () => RuntimeSnapshot.parse(await request("snapshot")),
      crash,
      output: () => output,
      async [Symbol.asyncDispose]() {
        if (!ended) {
          try {
            await request("stop")
            await closed.promise
          } finally {
            await crash()
          }
        }
      },
    }
  } catch (error) {
    await crash()
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
