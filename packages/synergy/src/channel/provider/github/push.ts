import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { Global } from "@/global"

export class PublishNonFastForwardError extends Error {
  override readonly name = "PublishNonFastForwardError"
  constructor(branch: string) {
    super(`push to ${branch} rejected as non-fast-forward; human reconciliation required`)
  }
}

export class PublishGitUncertainError extends Error {
  override readonly name = "PublishGitUncertainError"
  constructor() {
    super("Oryn Git push outcome unknown; remote reconciliation required")
  }
}

// Git reads repository config even with system/global config disabled. A private bare
// repository excludes candidate hooks, URL rewrites and credential helpers entirely.
// https://git-scm.com/docs/git#Documentation/git.txt-GIT_ALTERNATE_OBJECT_DIRECTORIES
// https://git-scm.com/docs/git-config#Documentation/git-config.txt-credentialuseHttpPath
const credentialHelper = `!f() {
  test "$1" = get || exit 0
  protocol= host= credential_path=
  while IFS= read -r line && test -n "$line"; do
    case "$line" in
      protocol=*) protocol=\${line#protocol=} ;;
      host=*) host=\${line#host=} ;;
      path=*) credential_path=\${line#path=} ;;
    esac
  done
  test "$protocol" = https && test "$host" = github.com && test "$credential_path" = "$ORYN_GITHUB_CREDENTIAL_PATH" || exit 0
  printf 'username=x-access-token\\npassword=%s\\n' "$SYNERGY_GITHUB_INSTALLATION_TOKEN"
}; f`

export namespace OrynGithubPush {
  export async function push(input: {
    repository: string
    directory: string
    candidateSha: string
    branch: string
    token: string
    signal?: AbortSignal
  }) {
    input.signal?.throwIfAborted()
    if (process.platform === "win32") throw new Error("Oryn publication requires a POSIX Host")
    if (
      !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(input.repository) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.candidateSha) ||
      !input.branch ||
      input.branch.length > 240 ||
      !/^[\x21-\x7e]+$/.test(input.token)
    )
      throw new Error("Invalid Oryn push identity")
    const searchPath = (process.env.PATH ?? "").split(path.delimiter).filter(path.isAbsolute).join(path.delimiter)
    const binary = Bun.which("git", { PATH: searchPath })
    if (!binary) throw new Error("Git is unavailable for Oryn publication")
    const git = await realpath(binary)
    const directory = await realpath(input.directory)
    if (git === directory || git.startsWith(directory + path.sep))
      throw new Error("Publication requires a Host-installed Git executable")
    const env = {
      PATH: searchPath,
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/dev/null",
      GIT_CONFIG_KEY_1: "core.fsmonitor",
      GIT_CONFIG_VALUE_1: "false",
    }
    const run = async (cwd: string, args: string[], extra: Record<string, string> = {}) => {
      input.signal?.throwIfAborted()
      const child = (() => {
        try {
          return Bun.spawn([git, ...args], {
            cwd,
            env: { ...env, ...extra },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "ignore",
            detached: true,
            maxBuffer: 256 * 1024,
            killSignal: "SIGKILL",
          })
        } catch {
          throw new PublishGitUncertainError()
        }
      })()
      const stop = () => {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
        }
      }
      const timer = setTimeout(stop, 120_000)
      input.signal?.addEventListener("abort", stop, { once: true })
      try {
        if (input.signal?.aborted) stop()
        const [exit, output] = await Promise.all([child.exited, new Response(child.stdout).text()])
        if (input.signal?.aborted) throw new PublishGitUncertainError()
        return { exit, output: output.trim() }
      } catch {
        throw new PublishGitUncertainError()
      } finally {
        clearTimeout(timer)
        input.signal?.removeEventListener("abort", stop)
        stop()
        await child.exited
      }
    }

    const inspect = async (args: string[]) => {
      const result = await run(directory, ["--no-optional-locks", ...args])
      if (result.exit !== 0) throw new Error("Candidate Git objects could not be resolved")
      return result.output
    }
    const objects = await realpath(await inspect(["rev-parse", "--path-format=absolute", "--git-path", "objects"]))
    const format = await inspect(["rev-parse", "--show-object-format"])
    if (!["sha1", "sha256"].includes(format)) throw new Error("Unsupported candidate Git object format")
    await mkdir(Global.Path.cache, { recursive: true })
    const scratch = await mkdtemp(path.join(Global.Path.cache, "oryn-push-"))
    try {
      const init = await run(scratch, ["init", "--bare", "--template=", `--object-format=${format}`, "."])
      if (init.exit !== 0) throw new Error("Private publication repository could not be initialized")
      const objectEnv = { GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(objects) }
      const ref = `refs/heads/${input.branch}`
      const checked = await run(scratch, ["check-ref-format", ref])
      if (checked.exit !== 0) throw new Error("Invalid Oryn publication branch")
      const commit = await run(scratch, ["cat-file", "-t", input.candidateSha], objectEnv)
      if (commit.exit !== 0 || commit.output !== "commit") throw new Error("Publication requires a candidate commit")
      const result = await run(
        scratch,
        [
          "-c",
          "protocol.allow=never",
          "-c",
          "protocol.https.allow=always",
          "-c",
          "http.followRedirects=false",
          "-c",
          "http.sslVerify=true",
          "-c",
          "credential.helper=",
          "-c",
          `credential.helper=${credentialHelper}`,
          "-c",
          "credential.useHttpPath=true",
          "push",
          "--porcelain",
          "--no-signed",
          "--recurse-submodules=no",
          "--",
          `https://github.com/${input.repository}.git`,
          `${input.candidateSha}:${ref}`,
        ],
        {
          ...objectEnv,
          SYNERGY_GITHUB_INSTALLATION_TOKEN: input.token,
          ORYN_GITHUB_CREDENTIAL_PATH: `${input.repository}.git`,
        },
      )
      if (result.exit !== 0) {
        if (
          result.output
            .split("\n")
            .some((line) => /^!\t[^\t]+\t\[rejected\] \((non-fast-forward|fetch first)\)$/.test(line))
        )
          throw new PublishNonFastForwardError(input.branch)
        throw new PublishGitUncertainError()
      }
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }
}
