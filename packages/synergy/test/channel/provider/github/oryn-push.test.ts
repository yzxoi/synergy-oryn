import { chmod, mkdir } from "node:fs/promises"
import path from "node:path"
import { describe, expect, spyOn, test } from "bun:test"
import { GitHubChannelAuth } from "../../../../src/channel/provider/github/api"
import {
  OrynGithubPush,
  PublishGitUncertainError,
  PublishNonFastForwardError,
} from "../../../../src/channel/provider/github/push"
import { OrynGithubPublish } from "../../../../src/channel/provider/github/publish"
import { tmpdir } from "../../../fixture/fixture"

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const git = Bun.which("git")!

async function run(directory: string, args: string[]) {
  const child = Bun.spawn([git, ...args], {
    cwd: directory,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exit) throw new Error(stderr)
  return stdout.trim()
}

async function fixture() {
  const root = await tmpdir({ git: true })
  const remote = path.join(root.path, "remote.git")
  const helperDir = path.join(root.path, "https-helper")
  const marker = path.join(root.path, "executed")
  const capture = path.join(root.path, "capture")
  await run(root.path, ["init", "--bare", remote])
  await mkdir(helperDir)
  const helper = path.join(helperDir, "git-remote-https")
  // Only HTTPS transport is substituted: Git still executes its real push and receive-pack protocol.
  await Bun.write(
    helper,
    `#!/bin/sh
printf '%s\\n' "$2" "$PWD" > ${quote(capture)}
env > ${quote(capture + ".env")}
printf '%s\\n' "protocol=https" "host=github.com" "path=acme/widget.git" "" | ${quote(git)} credential fill >> ${quote(capture)} 2>/dev/null
printf '%s\\n' "protocol=https" "host=elsewhere.invalid" "path=acme/widget.git" "" | ${quote(git)} credential fill > ${quote(capture + ".wrong-host")} 2>/dev/null
printf '%s\\n' "protocol=https" "host=github.com" "path=acme/other.git" "" | ${quote(git)} credential fill > ${quote(capture + ".wrong-repo")} 2>/dev/null
IFS= read -r command
[ "$command" = capabilities ] || exit 21
printf 'connect\\n\\n'
IFS= read -r command
[ "$command" = 'connect git-receive-pack' ] || exit 22
printf '\\n'
unset SYNERGY_GITHUB_INSTALLATION_TOKEN GIT_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
exec ${quote(git)} receive-pack ${quote(remote)}
`,
  )
  await chmod(helper, 0o700)
  const hooks = path.join(root.path, "hooks")
  await mkdir(hooks)
  await Bun.write(path.join(hooks, "pre-push"), `#!/bin/sh\nprintf hook >> ${quote(marker)}\nexit 1\n`)
  await chmod(path.join(hooks, "pre-push"), 0o700)
  await run(root.path, ["config", "core.hooksPath", hooks])
  await run(root.path, ["remote", "add", "origin", "https://github.com/acme/incorrect.git"])
  await run(root.path, ["config", "url.https://elsewhere.invalid/.insteadOf", "https://github.com/"])
  await run(root.path, ["config", "credential.helper", `!printf credential >> ${quote(marker)}`])
  const sha = await run(root.path, ["rev-parse", "HEAD"])
  return { root, remote, helperDir, marker, capture, sha }
}

function mockHttps(helperDir: string) {
  const original = Bun.spawn
  return spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
    const command = args[0]
    if (Array.isArray(command) && command.includes("push")) {
      const options = args[1]!
      return original(command, { ...options, env: { ...options.env, GIT_EXEC_PATH: helperDir } })
    }
    return original(...args)
  }) as typeof Bun.spawn)
}

function request(data: Awaited<ReturnType<typeof fixture>>) {
  return {
    repository: "acme/widget",
    directory: data.root.path,
    candidateSha: data.sha,
    branch: "codex/oryn/fixture",
    token: "fixture-installation-token",
  }
}

describe("Oryn credential-bearing Git push", () => {
  test("pushes the exact candidate without executing candidate hooks, helpers or URL rewrites", async () => {
    const fixtureData = await fixture()
    await using root = fixtureData.root
    const { remote, helperDir, marker, capture, sha } = fixtureData
    using token = spyOn(GitHubChannelAuth, "resolveInstallationToken").mockResolvedValue("fixture-installation-token")
    using send = spyOn(GitHubChannelAuth.GitHubClient, "send").mockResolvedValue({ number: 55 })
    using transport = mockHttps(helperDir)
    await OrynGithubPublish.createTransport().execute({
      operation: "ensure_draft",
      repository: "acme/widget",
      directory: root.path,
      candidateSha: sha,
      branch: "codex/oryn/fixture",
      title: "fix: fixture",
      body: "fixture",
    })
    expect(await run(remote, ["rev-parse", "refs/heads/codex/oryn/fixture"])).toBe(sha)
    expect(await Bun.file(marker).exists()).toBe(false)
    const lines = (await Bun.file(capture).text()).split("\n")
    expect(lines[0]).toBe("https://github.com/acme/widget.git")
    expect(lines[1]).not.toBe(root.path)
    expect(lines).toContain("password=fixture-installation-token")
    expect(await Bun.file(capture + ".wrong-host").text()).not.toContain("fixture-installation-token")
    expect(await Bun.file(capture + ".wrong-repo").text()).not.toContain("fixture-installation-token")
  })

  test("drops ambient Git, startup and credential settings and supports a linked worktree", async () => {
    const data = await fixture()
    await using root = data.root
    const worktree = path.join(root.path, "linked")
    await run(root.path, ["worktree", "add", "--detach", worktree, data.sha])
    using transport = mockHttps(data.helperDir)
    const hostile = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "url.https://ambient.invalid/.insteadOf",
      GIT_CONFIG_VALUE_0: "https://github.com/",
      GIT_CONFIG_GLOBAL: path.join(root.path, ".git/config"),
      GIT_DIR: path.join(root.path, ".git"),
      GIT_ASKPASS: data.marker,
      BASH_ENV: data.marker,
      GH_TOKEN: "ambient-secret",
      HTTPS_PROXY: "http://ambient.invalid",
    }
    const previous = Object.fromEntries(Object.keys(hostile).map((key) => [key, process.env[key]]))
    try {
      Object.assign(process.env, hostile)
      await OrynGithubPush.push({ ...request(data), directory: worktree })
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    expect(await run(data.remote, ["rev-parse", "refs/heads/codex/oryn/fixture"])).toBe(data.sha)
    const environment = await Bun.file(data.capture + ".env").text()
    expect(environment).not.toContain("ambient")
    expect(environment).not.toContain("BASH_ENV=")
    expect(environment).toContain("GIT_DIR=.\n")
    expect(await Bun.file(data.marker).exists()).toBe(false)
  })

  test("rejects a diverged remote without replacing its commit", async () => {
    const data = await fixture()
    await using root = data.root
    using transport = mockHttps(data.helperDir)
    await OrynGithubPush.push(request(data))
    const tree = await run(data.remote, ["rev-parse", `${data.sha}^{tree}`])
    const human = await run(data.remote, [
      "-c",
      "user.name=Human",
      "-c",
      "user.email=human@example.test",
      "commit-tree",
      tree,
      "-p",
      data.sha,
      "-m",
      "human change",
    ])
    await run(data.remote, ["update-ref", "refs/heads/codex/oryn/fixture", human])
    await expect(OrynGithubPush.push({ ...request(data), expectedHead: data.sha })).rejects.toBeInstanceOf(
      PublishNonFastForwardError,
    )
    expect(await run(data.remote, ["rev-parse", "refs/heads/codex/oryn/fixture"])).toBe(human)
  })

  test("suppresses transport diagnostics and keeps failed transport outcomes uncertain", async () => {
    const data = await fixture()
    await using root = data.root
    using transport = mockHttps(data.helperDir)
    await Bun.write(
      path.join(data.helperDir, "git-remote-https"),
      '#!/bin/sh\nprintf "%s" "$SYNERGY_GITHUB_INSTALLATION_TOKEN:$PWD" >&2\nexit 42\n',
    )
    let failure: unknown
    try {
      await OrynGithubPush.push(request(data))
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(PublishGitUncertainError)
    expect(String(failure)).not.toContain("fixture-installation-token")
    expect(String(failure)).not.toContain(root.path)
  })

  test("cancellation kills the owned transport process group and removes private scratch", async () => {
    const data = await fixture()
    await using root = data.root
    using transport = mockHttps(data.helperDir)
    await Bun.write(
      path.join(data.helperDir, "git-remote-https"),
      `#!/bin/sh\nprintf '%s' "$PWD" > ${quote(data.capture)}\nsleep 120 &\nprintf '%s' "$!" > ${quote(data.capture + ".pid")}\nwait\n`,
    )
    const controller = new AbortController()
    const pending = OrynGithubPush.push({ ...request(data), signal: controller.signal })
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    )
    try {
      while (!(await Bun.file(data.capture + ".pid").exists())) await Bun.sleep(10)
      controller.abort()
      expect(await outcome).toBeInstanceOf(PublishGitUncertainError)
      const directory = await Bun.file(data.capture).text()
      expect(await Bun.file(path.join(directory, "config")).exists()).toBe(false)
      const pid = Number(await Bun.file(data.capture + ".pid").text())
      const ps = Bun.spawn(["ps", "-o", "stat=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" })
      const [status] = await Promise.all([new Response(ps.stdout).text(), ps.exited])
      expect(status.trim() === "" || status.trim().startsWith("Z")).toBe(true)
    } finally {
      controller.abort()
      await pending.catch(() => {})
    }
  })
})
