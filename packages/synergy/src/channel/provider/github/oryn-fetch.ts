import { mkdir, mkdtemp, rm, realpath } from "node:fs/promises"
import path from "node:path"
import { Global } from "../../../global"
import { OrynGit } from "../../../oryn/git"
import { GitHubChannelAuth } from "./api"

// Credentials are confined to a private bare repository, never the contributor's
// checkout/config/hooks. Only immutable objects are imported into the trusted clone.
// https://git-scm.com/docs/git-fetch
export async function fetchOrynReview(input: {
  repository: string
  directory: string
  headSha: string
  baseSha: string
  signal?: AbortSignal
}) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(input.repository) ||
    ![input.headSha, input.baseSha].every((sha) => /^[a-f0-9]{40}$/.test(sha))
  )
    throw new Error("Invalid review source")
  const directory = await realpath(input.directory)
  input.signal?.throwIfAborted()
  const requested = [...new Set([input.headSha, input.baseSha])]
  const missing: string[] = []
  for (const sha of requested) {
    const present = await OrynGit.read(directory, ["cat-file", "-e", `${sha}^{commit}`]).then(
      () => true,
      () => false,
    )
    if (!present) missing.push(sha)
    else await OrynGit.read(directory, ["update-ref", `refs/oryn/objects/${sha}`, sha])
  }
  if (!missing.length) return
  const [owner, repo] = input.repository.split("/")
  const token = await GitHubChannelAuth.resolveInstallationToken(owner!, repo!, input.signal)
  await mkdir(Global.Path.cache, { recursive: true })
  const scratch = await mkdtemp(path.join(Global.Path.cache, "oryn-fetch-"))
  const env = OrynGit.environment()
  const run = async (cwd: string, args: string[], credentials = false) => {
    input.signal?.throwIfAborted()
    const child = Bun.spawn(["git", ...args], {
      cwd,
      env: { ...env, ...(credentials ? { ORYN_FETCH_TOKEN: token } : {}) },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: process.platform !== "win32",
      killSignal: "SIGKILL",
    })
    const abort = () => {
      try {
        if (process.platform === "win32") child.kill("SIGKILL")
        else process.kill(-child.pid, "SIGKILL")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      }
    }
    const timer = setTimeout(abort, 120_000)
    input.signal?.addEventListener("abort", abort, { once: true })
    try {
      if (input.signal?.aborted) abort()
      if (await child.exited) throw new Error("Review source fetch failed")
      input.signal?.throwIfAborted()
    } finally {
      clearTimeout(timer)
      abort()
      input.signal?.removeEventListener("abort", abort)
    }
  }
  try {
    await run(scratch, ["init", "--bare", "--template=", "."])
    const objects = await realpath(
      await OrynGit.read(directory, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]),
    )
    await Bun.write(path.join(scratch, "objects", "info", "alternates"), `${JSON.stringify(objects)}\n`)
    const known = await OrynGit.read(directory, ["rev-parse", "--verify", "HEAD^{commit}"])
    await run(scratch, ["update-ref", "refs/oryn/have", known])
    await run(
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
        'credential.helper=!f() { test "$1" = get || exit 0; printf "username=x-access-token\\npassword=%s\\n" "$ORYN_FETCH_TOKEN"; }; f',
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        "--",
        `https://github.com/${input.repository}.git`,
        ...missing,
      ],
      true,
    )
    await run(directory, [
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.file.allow=always",
      "fetch",
      "--no-write-fetch-head",
      "--no-tags",
      "--no-recurse-submodules",
      "--",
      scratch,
      ...missing,
    ])
    for (const sha of [input.headSha, input.baseSha]) {
      await OrynGit.read(directory, ["cat-file", "-e", `${sha}^{commit}`])
      await OrynGit.read(directory, ["update-ref", `refs/oryn/objects/${sha}`, sha])
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
