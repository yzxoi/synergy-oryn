import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { SandboxBackend } from "../../src/sandbox/backend"
import { tmpdir } from "../fixture/fixture"

function wrapper(script: string, tempPath?: string) {
  return { command: process.execPath, args: ["-e", script], sandboxed: false, tempPath }
}

describe("sandbox async process lifecycle", () => {
  test("drains both pipes after the shared byte limit without blocking the writer", async () => {
    let delivered = 0
    const result = await SandboxBackend.executeAsync(
      wrapper(
        `import { writeSync } from 'node:fs'; const b=Buffer.alloc(65536, 120); for(let i=0;i<64;i++){writeSync(1,b);writeSync(2,b)}`,
      ),
      {
        fallbackPolicy: "allow",
        timeoutMs: 3000,
        maxOutputBytes: 1024,
        onStdout: (chunk) => {
          delivered += chunk.length
        },
        onStderr: (chunk) => {
          delivered += chunk.length
        },
      },
    )
    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBe(1024)
    expect(delivered).toBe(1024)
  }, 10000)

  test("pre-aborted calls never spawn and still remove their temporary profile", async () => {
    await using dir = await tmpdir()
    const tempPath = join(dir.path, "profile.sb")
    const marker = join(dir.path, "started")
    await Bun.write(tempPath, "fixture")
    let spawned = false
    const reason = new Error("cancel before spawn")
    await expect(
      SandboxBackend.executeAsync(wrapper(`await Bun.write(${JSON.stringify(marker)}, 'started')`, tempPath), {
        fallbackPolicy: "allow",
        signal: AbortSignal.abort(reason),
        after_spawn: () => {
          spawned = true
        },
      }),
    ).rejects.toThrow("cancel before spawn")
    expect(spawned).toBe(false)
    expect(await Bun.file(marker).exists()).toBe(false)
    expect(await Bun.file(tempPath).exists()).toBe(false)
  })

  test("spawn errors remove the temporary profile", async () => {
    await using dir = await tmpdir()
    const tempPath = join(dir.path, "profile.sb")
    await Bun.write(tempPath, "fixture")
    await expect(
      SandboxBackend.executeAsync(wrapper("console.log(1)", tempPath), {
        fallbackPolicy: "allow",
        cwd: join(dir.path, "missing"),
      }),
    ).rejects.toThrow()
    expect(await Bun.file(tempPath).exists()).toBe(false)
  })

  test("failing spawn hooks clean up profiles and children", async () => {
    await using dir = await tmpdir()
    const tempPath = join(dir.path, "profile.sb")
    await Bun.write(tempPath, "fixture")
    await expect(
      SandboxBackend.executeAsync(wrapper("setInterval(()=>{},1000)", tempPath), {
        fallbackPolicy: "allow",
        after_spawn: () => {
          throw new Error("hook failure")
        },
      }),
    ).rejects.toThrow("hook failure")
    expect(await Bun.file(tempPath).exists()).toBe(false)
  })

  test("denied sandbox fallback cleans the profile without spawning", async () => {
    await using dir = await tmpdir()
    const tempPath = join(dir.path, "profile.sb")
    await Bun.write(tempPath, "fixture")
    let spawned = false
    await expect(
      SandboxBackend.executeAsync(
        { ...wrapper("console.log('unexpected')", tempPath), skipReason: "fixture unavailable" },
        {
          fallbackPolicy: "deny",
          after_spawn: () => {
            spawned = true
          },
        },
      ),
    ).rejects.toThrow("Sandbox required but unavailable")
    expect(spawned).toBe(false)
    expect(await Bun.file(tempPath).exists()).toBe(false)
  })

  test("timeout includes a pending spawn hook", async () => {
    const result = await SandboxBackend.executeAsync(wrapper("setInterval(()=>{},1000)"), {
      fallbackPolicy: "allow",
      timeoutMs: 100,
      after_spawn: () => new Promise<void>(() => {}),
    })
    expect(result.timedOut).toBe(true)
  }, 5000)

  test("explicit environment does not inherit runtime HOME or executable lookup hooks", async () => {
    const result = await SandboxBackend.executeAsync(
      wrapper(
        "console.log(JSON.stringify({home:process.env.HOME,node:process.env.NODE_PATH,custom:process.env.ORYN_FIXTURE}))",
      ),
      {
        fallbackPolicy: "allow",
        inheritEnv: false,
        env: { ORYN_FIXTURE: "present" },
      },
    )
    expect(JSON.parse(result.stdout)).toEqual({ custom: "present" })
  })

  test("output callback failure cancels and cleans up execution", async () => {
    await using dir = await tmpdir()
    const tempPath = join(dir.path, "profile.sb")
    await Bun.write(tempPath, "fixture")
    await expect(
      SandboxBackend.executeAsync(wrapper("console.log('ready');setInterval(()=>{},1000)", tempPath), {
        fallbackPolicy: "allow",
        timeoutMs: 3000,
        onStdout: () => {
          throw new Error("output consumer failed")
        },
      }),
    ).rejects.toThrow("output consumer failed")
    expect(await Bun.file(tempPath).exists()).toBe(false)
  })

  test.skipIf(process.platform === "win32")(
    "cancellation reaps a descendant that ignores SIGTERM",
    async () => {
      const controller = new AbortController()
      const childCode = `process.on('SIGTERM',()=>{});console.log('descendant:'+process.pid);setInterval(()=>{},1000)`
      const script = `import {spawn} from 'node:child_process'; spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore',1,2]}); setInterval(()=>{},1000)`
      let pid: number | undefined
      let output = ""
      try {
        const result = await SandboxBackend.executeAsync(wrapper(script), {
          fallbackPolicy: "allow",
          signal: controller.signal,
          timeoutMs: 3000,
          onStdout: (chunk) => {
            output += chunk.toString()
            const match = output.match(/descendant:(\d+)/)
            if (match) {
              pid = Number(match[1])
              controller.abort()
            }
          },
        })
        expect(pid).toBeDefined()
        expect(result.timedOut).toBe(true)
        let alive = true
        for (let i = 0; i < 100 && alive; i++) {
          try {
            process.kill(pid!, 0)
            await Bun.sleep(20)
          } catch {
            alive = false
          }
        }
        expect(alive).toBe(false)
      } finally {
        if (pid) {
          try {
            process.kill(pid, "SIGKILL")
          } catch {}
        }
      }
    },
    10000,
  )
})
