import { describe, expect, test } from "bun:test"
import { ToolExecutor } from "../../src/session/tool-executor"

describe("ToolExecutor", () => {
  test("classifies capability families without changing tool identities", () => {
    expect(ToolExecutor.classify("bash")).toBe("local_process")
    expect(ToolExecutor.classify("read")).toBe("file")
    expect(ToolExecutor.classify("scan_files")).toBe("file")
    expect(ToolExecutor.classify("resolve_conflicts")).toBe("file")
    expect(ToolExecutor.classify("browser_action")).toBe("browser")
    expect(ToolExecutor.classify("link_invoke")).toBe("link")
    expect(
      ToolExecutor.classify("plugin__example__probe", {
        type: "plugin",
        pluginId: "example",
        toolId: "probe",
        runtimeMode: "process",
      }),
    ).toBe("plugin")
    expect(
      ToolExecutor.classify("local__custom__probe", {
        type: "local",
      }),
    ).toBe("plugin")
    expect(ToolExecutor.classify("task")).toBe("control_plane")
    expect(ToolExecutor.classify("question")).toBe("control_plane")
  })
})

test("host admission can select an executor without exposing model-controlled quotas", async () => {
  const dispose = ToolExecutor.registerAdmissionProvider("fixture_admission", async () => ({
    executor: "local_process",
    resources: [{ key: "trusted-profile", limit: 1 }],
  }))
  try {
    const input = {
      toolName: "fixture_admission",
      executor: "control_plane" as const,
      sessionID: "fixture",
      signal: new AbortController().signal,
      input: { resources: [{ key: "trusted-profile", limit: 999 }] },
    }
    expect(await ToolExecutor.admission(input)).toEqual({
      executor: "local_process",
      resources: [{ key: "trusted-profile", limit: 1 }],
    })
    expect(await ToolExecutor.admission({ ...input, executor: "plugin" })).toEqual({ executor: "plugin" })
    await expect(
      ToolExecutor.admission({ ...input, signal: AbortSignal.abort(new Error("cancelled")) }),
    ).rejects.toThrow("cancelled")
  } finally {
    dispose()
  }
})
