import { expect, test } from "bun:test"
import { SandboxDetector } from "../../src/enforcement/sandbox-detector"

test("read-only filesystem errors are write restrictions rather than behavioral failures", () => {
  for (const output of [
    "EROFS: read-only file system, open 'source.ts'",
    "sh: cannot create result: Read-only file system",
  ]) {
    expect(SandboxDetector.bestMatch(output)).toMatchObject({ access: "write", label: "readonly_filesystem" })
  }
  expect(SandboxDetector.bestMatch("AssertionError: expected result to equal 42")).toBeNull()
})
