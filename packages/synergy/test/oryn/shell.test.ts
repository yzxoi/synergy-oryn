import { z } from "zod"
import { mkdir, symlink } from "node:fs/promises"
import { ProcessRegistry } from "../../src/process/registry"
import { SandboxBackend } from "../../src/sandbox/backend"
import { OrynShell } from "../../src/oryn/shell"
import "../../src/product-registration"
import { expect, spyOn, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { BossService } from "../../src/boss/boss"
import { OrynService } from "../../src/oryn/service"
import { OrynStore } from "../../src/oryn/store"
import { ModelsDev } from "../../src/provider/models-schemas"
import { Provider } from "../../src/provider/provider"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionProcessor } from "../../src/session/processor"
import { ToolResolver } from "../../src/session/tool-resolver"
import { tmpdir } from "./fixture"

async function fixture(
  fn: (input: {
    sessionID: string
    directory: string
    caseId: string
    assignmentId: string
    attemptId: string
  }) => Promise<void>,
) {
  await using repo = await tmpdir({
    git: true,
    config: {
      oryn: {
        enabled: true,
        routes: [{ feishuAccount: "test", repoAlias: "repo" }],
        repositories: { repo: { owner: "test", repo: "repo" } },
      },
    },
  })
  await ScopeContext.provide({
    scope: await repo.scope(),
    fn: async () => {
      const identity = { provider: "feishu" as const, accountId: "test", chatId: repo.path }
      const { claim } = await OrynStore.claimSource({ identity, requestKey: "shell" })
      await OrynStore.createCase({
        caseId: claim.caseId,
        kind: "bug",
        summary: "shell containment",
        repoAlias: "repo",
        sourceKeyHash: claim.sourceKey,
      })
      await Bun.write(`${repo.path}/source.ts`, "export const value = 1\n")
      await Bun.$`git add source.ts`.cwd(repo.path).quiet()
      await Bun.$`git commit -m "test: add shell source"`.cwd(repo.path).quiet()
      await Bun.$`git config fixture.token private-git-fixture-token`.cwd(repo.path).quiet()
      const baseline = (await Bun.$`git rev-parse HEAD`.cwd(repo.path).text()).trim()
      const root = await OrynService.openEngineeringSession({ caseId: claim.caseId, identity, baselineSha: baseline })
      try {
        const worker = await BossService.spawn(root.sessionID, {
          role: "code",
          agent: "oryn-code",
          workspace: "worktree",
          baseRevision: baseline,
        })
        const assignment = await OrynStore.createAssignment({
          caseId: claim.caseId,
          attemptId: root.attemptId,
          stage: "code",
          agentId: "oryn-code",
          epoch: 0,
          frozenInputsDigest: "fixture",
          sessionId: worker.id,
        })
        await OrynStore.setAssignmentWorkspace(claim.caseId, assignment.id, worker.workspace!.path)
        await OrynStore.bindSessionSource({ sessionID: worker.id, caseId: claim.caseId, role: "worker", identity })
        await ScopeContext.provide({
          scope: worker.scope,
          workspace: worker.workspace,
          fn: () =>
            fn({
              sessionID: worker.id,
              directory: worker.workspace!.path,
              caseId: claim.caseId,
              assignmentId: assignment.id,
              attemptId: root.attemptId,
            }),
        })
      } finally {
        await Session.remove(root.sessionID)
      }
    },
  })
}

async function execute(
  sessionID: string,
  command: string,
  background = false,
  extra: { workdir?: string; targetID?: string; linkID?: string } = {},
) {
  const session = await Session.get(sessionID)
  const catalog = await Bun.file(new URL("../tool/fixtures/models-api.json", import.meta.url)).json()
  const model = Provider.fromModelsDevProvider(ModelsDev.Provider.parse(catalog.openai)).models["gpt-4o"]
  const agent = (await Agent.get("oryn-code"))!
  const processor = SessionProcessor.create({
    sessionID,
    model,
    abort: new AbortController().signal,
    assistantMessage: {
      id: `msg_${crypto.randomUUID()}`,
      sessionID,
      role: "assistant",
      parentID: "msg_shell_request",
      modelID: model.id,
      providerID: model.providerID,
      mode: "build",
      agent: agent.name,
      path: { cwd: ScopeContext.current.directory, root: ScopeContext.current.scope.directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.now() },
    },
  })
  try {
    const resolved = await ToolResolver.resolveWithAvailability({
      sessionID,
      session,
      model,
      agent,
      processor,
      userTools: { bash: true },
      includeMCP: false,
    })
    const bash = resolved.executionTools.bash
    if (!bash?.execute) throw new Error("coder has no bash execution tool")
    const result = await bash.execute(
      { command, description: "Probe coder shell execution", background, ...extra },
      { toolCallId: crypto.randomUUID(), messages: [] },
    )
    return z
      .object({
        output: z.string(),
        metadata: z
          .object({
            exit: z.number().nullable().optional(),
            processId: z.string().optional(),
            background: z.boolean().optional(),
          })
          .passthrough(),
      })
      .parse(result)
  } finally {
    processor.dispose("test")
  }
}

const native = test.skipIf(!["darwin", "linux"].includes(process.platform))

native("coder shell uses a private home and does not inherit credentials or runtime search paths", async () => {
  await fixture(async ({ sessionID, directory }) => {
    const keys = [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "OPENAI_API_KEY",
      "FEISHU_APP_SECRET",
      "NODE_PATH",
      "PYTHONPATH",
      "GIT_EXEC_PATH",
    ]
    const saved = new Map(keys.map((key) => [key, process.env[key]]))
    for (const key of keys) process.env[key] = "private-env-fixture-token"
    try {
      await Bun.write(
        `${directory}/probe.ts`,
        `console.log(JSON.stringify({home:process.env.HOME,values:${JSON.stringify(keys)}.map(key=>process.env[key]??null)}))`,
      )
      const output = await execute(sessionID, "bun probe.ts")
      expect(output.metadata.exit, output.output).toBe(0)
      const observed = JSON.parse(output.output)
      expect(observed.home).not.toBe(process.env.HOME)
      expect(observed.values).toEqual(keys.map(() => null))
      expect(await Bun.file(`${observed.home}/git/HEAD`).exists()).toBe(false)
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})

native("coder shell can edit and inspect Git without reading host files or Git credentials", async () => {
  await fixture(async ({ sessionID, directory }) => {
    await using outside = await tmpdir()
    await Bun.write(`${outside.path}/private.txt`, "private-host-fixture")
    await symlink(`${outside.path}/private.txt`, `${directory}/escape`)
    await Bun.write(
      `${directory}/probe.ts`,
      `import {readFileSync,writeFileSync,statSync,readdirSync} from 'node:fs';
const parentMetadata=statSync('..').isDirectory();let parentList=false;try{readdirSync('..');parentList=true}catch{}
let escape=false;try{readFileSync('escape');escape=true}catch{}
writeFileSync('source.ts','export const value = 2\\n');
const diff=Bun.spawnSync(['git','diff','--','source.ts']);
const status=Bun.spawnSync(['git','status','--porcelain=v1']);
const credential=Bun.spawnSync(['git','config','--get','fixture.token']);
console.log(JSON.stringify({escape,parentMetadata,parentList,diff:diff.stdout.toString(),exit:diff.exitCode,statusExit:status.exitCode,status:status.stdout.toString(),error:diff.stderr.toString(),credential:credential.stdout.toString()}));`,
    )
    const output = await execute(sessionID, "bun probe.ts")
    expect(output.metadata.exit, output.output).toBe(0)
    const observed = JSON.parse(output.output)
    expect(observed, observed.error).toMatchObject({
      escape: false,
      parentMetadata: true,
      ...(process.platform === "darwin" ? { parentList: false } : {}),
      exit: 0,
      statusExit: 0,
      credential: "",
    })
    expect(observed.diff).toContain("+export const value = 2")
    expect(observed.status).toContain(" M source.ts")
    expect(await Bun.file(`${directory}/source.ts`).text()).toContain("value = 2")
  })
})

native("frozen candidate shells remain read-only even under full access", async () => {
  await fixture(async ({ sessionID, directory, caseId, attemptId }) => {
    await OrynStore.mutateAttempt(caseId, attemptId, (attempt) => ({
      ...attempt,
      candidateSha: attempt.baselineSha,
      disposition: "candidate_frozen",
    }))
    await Session.updateControlProfile(sessionID, "full_access")
    const result = await execute(sessionID, "printf changed > source.ts")
    expect(result.metadata.exit).not.toBe(0)
    expect(await Bun.file(`${directory}/source.ts`).text()).toContain("value = 1")
  })
})

native("shell network policy denies access to the local control plane", async () => {
  await fixture(async ({ sessionID, directory }) => {
    let requests = 0
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++
        return new Response("private-server-fixture")
      },
    })
    try {
      await Bun.write(
        `${directory}/probe.ts`,
        `try {await fetch('http://127.0.0.1:${server.port}', {signal:AbortSignal.timeout(1000)});console.log('connected')}catch{console.log('denied')}`,
      )
      const result = await execute(sessionID, "bun probe.ts")
      expect(result.metadata.exit, result.output).toBe(0)
      expect(result.output.trim()).toBe("denied")
      expect(requests).toBe(0)
    } finally {
      await server.stop(true)
    }
  })
})

native(
  "tracked background shells retain private scratch until physical exit",
  async () => {
    await fixture(async ({ sessionID, directory }) => {
      await Bun.write(
        `${directory}/background.ts`,
        "await Bun.write('home-path',process.env.HOME!);await Bun.sleep(30000)",
      )
      const result = await execute(sessionID, "bun background.ts", true)
      expect(result.metadata.background).toBe(true)
      const id = result.metadata.processId!
      try {
        const deadline = Date.now() + 5000
        while (!(await Bun.file(`${directory}/home-path`).exists()) && Date.now() < deadline) await Bun.sleep(10)
        const home = await Bun.file(`${directory}/home-path`).text()
        expect(await Bun.file(`${home}/git/HEAD`).exists()).toBe(true)
        const proc = ProcessRegistry.get(id)!
        await ProcessRegistry.terminate(proc)
        const closed = Date.now() + 5000
        while (!ProcessRegistry.getFinished(id) && Date.now() < closed) await Bun.sleep(10)
        expect(ProcessRegistry.getFinished(id)).toBeDefined()
        expect(await Bun.file(`${home}/git/HEAD`).exists()).toBe(false)
      } finally {
        const proc = ProcessRegistry.get(id)
        if (proc?.child) await ProcessRegistry.terminate(proc)
        ProcessRegistry.remove(id)
      }
    })
  },
  15000,
)

native("Host policy rejects sandbox fallback before a child side effect", async () => {
  await fixture(async ({ sessionID, directory }) => {
    const unavailable = spyOn(SandboxBackend, "prepareWrapper").mockImplementation((input) => ({
      command: input.command,
      args: input.args,
      sandboxed: false,
      skipReason: "fixture sandbox unavailable",
    }))
    try {
      await expect(execute(sessionID, "printf changed > marker")).rejects.toThrow("Host shell sandbox unavailable")
    } finally {
      unavailable.mockRestore()
    }
    expect(await Bun.file(`${directory}/marker`).exists()).toBe(false)
  })
})

native("shell preparation revalidates human takeover after policy resolution", async () => {
  await fixture(async ({ sessionID, directory, caseId }) => {
    const policy = await OrynShell.resolve({
      sessionID,
      agent: "oryn-code",
      workspace: directory,
      abort: new AbortController().signal,
    })
    await OrynStore.requestHandoff(caseId, "Operator inspection required")
    await expect(policy!.prepare({ command: "printf changed > marker", extraReadRoots: [] })).rejects.toMatchObject({
      data: { code: "NOT_AUTHORIZED" },
    })
    expect(await Bun.file(`${directory}/marker`).exists()).toBe(false)
  })
})

native("shell workdir stays inside its assignment and preserves subdirectory execution", async () => {
  await fixture(async ({ sessionID, directory }) => {
    await mkdir(`${directory}/nested`)
    const result = await execute(sessionID, "pwd", false, { workdir: `${directory}/nested` })
    expect(result.metadata.exit, result.output).toBe(0)
    expect(result.output.trim()).toBe(`${directory}/nested`)
    await Session.updateControlProfile(sessionID, "full_access")
    await expect(execute(sessionID, "pwd", false, { workdir: `${directory}/..` })).rejects.toThrow(
      "shell cwd is outside",
    )
  })
})

native("Host local shell policy rejects both remote addressing fields before resolution", async () => {
  await fixture(async ({ sessionID }) => {
    await Session.updateControlProfile(sessionID, "full_access")
    for (const extra of [{ targetID: "remote-fixture" }, { linkID: "remote-fixture" }])
      await expect(execute(sessionID, "pwd", false, extra)).rejects.toThrow("requires the built-in local bash executor")
  })
})

native(
  "background shell descendants cannot outlive the tracked parent drain",
  async () => {
    await fixture(async ({ sessionID, directory }) => {
      await Bun.write(
        `${directory}/descendant.ts`,
        "process.on('SIGTERM',()=>{});let count=0;setInterval(()=>Bun.write('heartbeat',String(++count)),20)",
      )
      await Bun.write(
        `${directory}/parent.ts`,
        "import {spawn} from 'node:child_process';const child=spawn('bun',['descendant.ts'],{stdio:'inherit'});child.unref();await Bun.write('descendant-pid',String(child.pid));await Bun.sleep(200);process.exit(0)",
      )
      const result = await execute(sessionID, "bun parent.ts", true)
      const id = result.metadata.processId!
      try {
        const deadline = Date.now() + 5000
        while (!ProcessRegistry.getFinished(id) && Date.now() < deadline) await Bun.sleep(10)
        expect(ProcessRegistry.getFinished(id)).toBeDefined()
        const before = await Bun.file(`${directory}/heartbeat`).text()
        await Bun.sleep(150)
        expect(await Bun.file(`${directory}/heartbeat`).text()).toBe(before)
      } finally {
        const proc = ProcessRegistry.get(id)
        if (proc?.child) await ProcessRegistry.terminate(proc, { allowExitedParent: true })
        const pidFile = Bun.file(`${directory}/descendant-pid`)
        if (await pidFile.exists()) {
          const pid = Number(await pidFile.text())
          try {
            process.kill(pid, "SIGKILL")
          } catch {}
        }
        ProcessRegistry.remove(id)
      }
    })
  },
  10000,
)

native("a similarly named unbound agent does not acquire Oryn shell restrictions", async () => {
  await fixture(async ({ directory }) => {
    expect(
      await OrynShell.resolve({
        sessionID: "unbound-oryn-personal",
        agent: "oryn-personal",
        workspace: directory,
        abort: new AbortController().signal,
      }),
    ).toBeUndefined()
  })
})
