import { describe, expect, test } from "bun:test"
import { mkdir, readFile, symlink } from "node:fs/promises"
import { join } from "node:path"
import { SandboxBackend } from "../../src/sandbox/backend"
import type { SynergySandboxPermissionProfile } from "../../src/sandbox/policy-engine"
import { tmpdir } from "../fixture/fixture"

function profile(workspace: string, scratch: string): SynergySandboxPermissionProfile {
  return {
    fileSystem: {
      workspace,
      readableRoots: [workspace, process.execPath, "/bin", "/usr/bin", "/usr/lib", "/System/Library"],
      writableRoots: [scratch],
      readOnlySubpaths: [],
      unreadableGlobs: [],
      protectedMetadataNames: [],
      protectedPaths: [],
      dataDenyRoots: [],
      includePlatformDefaults: false,
    },
    network: { mode: "restricted", allowLocalBinding: false, allowedUnixSockets: [] },
  }
}

describe("explicit sandbox permission profiles", () => {
  test("Linux helper receives approved roots without adding workspace writes or home reads", async () => {
    await using dir = await tmpdir()
    const policy = profile(dir.path, join(dir.path, "scratch"))
    const wrapper = SandboxBackend.prepareWrapper({
      command: "/bin/echo",
      args: ["fixture"],
      workspace: dir.path,
      executionCwd: policy.fileSystem.writableRoots[0],
      sandboxMode: "workspace_write",
      forcePlatform: "linux",
      forceHelperPath: "/fixture/helper",
      forceHelperVerified: true,
      permissionProfile: policy,
    })
    try {
      expect(wrapper.sandboxed).toBe(true)
      expect(JSON.parse(await readFile(wrapper.tempPath!, "utf8"))).toEqual(policy)
      expect(wrapper.args.slice(0, 2)).toEqual(["--sandbox-policy-cwd", policy.fileSystem.writableRoots[0]])
    } finally {
      if (wrapper.tempPath) SandboxBackend.cleanupTemp(wrapper.tempPath)
    }
  })

  test("legacy and unsupported backends cannot discard an explicit profile", () => {
    const policy = profile("/fixture/work", "/fixture/scratch")
    for (const [forcePlatform, backend] of [
      ["macos", "seatbelt-legacy-allow-default"],
      ["linux", "bwrap-inline-debug"],
      ["windows", undefined],
    ]) {
      const wrapper = SandboxBackend.prepareWrapper({
        command: "echo",
        args: [],
        workspace: policy.fileSystem.workspace,
        sandboxMode: "workspace_write",
        forcePlatform,
        backend,
        permissionProfile: policy,
      })
      try {
        expect(wrapper.sandboxed).toBe(false)
        expect(wrapper.skipReason).toContain("explicit permission profile")
      } finally {
        if (wrapper.tempPath) SandboxBackend.cleanupTemp(wrapper.tempPath)
      }
    }
  })

  test.skipIf(process.platform !== "darwin")(
    "native macOS enforces read-only source, private scratch and host network denial",
    async () => {
      await using dir = await tmpdir()
      const workspace = join(dir.path, "work")
      const scratch = join(dir.path, "scratch")
      const outside = join(dir.path, "host.txt")
      await mkdir(workspace)
      await mkdir(scratch)
      await Bun.write(join(workspace, "source.txt"), "source")
      await Bun.write(outside, "fixture host data")
      await symlink(outside, join(workspace, "escape"))
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("host") })
      try {
        const script = `
        import {readFileSync,writeFileSync} from 'node:fs';
        const result={source:readFileSync('source.txt','utf8'),scratch:false,sourceWrite:false,hostRead:false,symlinkRead:false,network:false};
        writeFileSync(process.env.HOME+'/output','ok'); result.scratch=true;
        try {writeFileSync('source.txt','tampered'); result.sourceWrite=true} catch {}
        try {readFileSync(${JSON.stringify(outside)}); result.hostRead=true} catch {}
        try {readFileSync('escape'); result.symlinkRead=true} catch {}
        try {await fetch('http://127.0.0.1:${server.port}',{signal:AbortSignal.timeout(2000)}); result.network=true} catch {}
        console.log(JSON.stringify(result));`
        const wrapper = SandboxBackend.prepareWrapper({
          command: process.execPath,
          args: ["-e", script],
          workspace,
          sandboxMode: "workspace_write",
          permissionProfile: profile(workspace, scratch),
        })
        const result = await SandboxBackend.executeAsync(wrapper, {
          cwd: workspace,
          env: { HOME: scratch, PATH: "/usr/bin:/bin" },
          inheritEnv: false,
          fallbackPolicy: "deny",
          timeoutMs: 5000,
        })
        expect(result.exitCode, result.stderr).toBe(0)
        expect(JSON.parse(result.stdout)).toEqual({
          source: "source",
          scratch: true,
          sourceWrite: false,
          hostRead: false,
          symlinkRead: false,
          network: false,
        })
        expect(await Bun.file(join(workspace, "source.txt")).text()).toBe("source")
      } finally {
        await server.stop(true)
      }
    },
    10000,
  )
})
