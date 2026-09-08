import path from "node:path"
import { realpath } from "node:fs/promises"
import { z } from "zod"
import { Config } from "../config/config"
import { Oryn, ChannelGithub } from "../config/schema"
import { Scope } from "../scope"
import { Storage } from "../storage/storage"
import { ManagedProjectOwnership } from "../channel/managed-project-ownership"
import { Lock } from "../util/lock"
import { externalIdentityHash } from "../util/identity"
import { OrynGit } from "./git"
import { OrynPath } from "./path"
import { ChannelSource } from "./schema"
import { storeError } from "./store"

export const OrynSetupInput = z
  .object({
    revision: z.string(),
    enabled: z.boolean(),
    repoAlias: z.string().min(1).max(120),
    githubAccount: z.string().min(1),
    repository: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/),
    directory: z.string().min(1),
    baseBranch: z.string().min(1).max(200),
    backfill: z.boolean(),
    autoReview: z.boolean(),
    autoFix: z.boolean(),
    notificationTarget: z.string().optional(),
  })
  .strict()
  .meta({ ref: "OrynSetupInput" })
export type OrynSetupInput = z.infer<typeof OrynSetupInput>
const Target = z
  .object({
    id: z.string(),
    accountId: z.string(),
    chatId: z.string(),
    threadId: z.string().optional(),
    label: z.string(),
  })
  .strict()
export const OrynSetupView = z
  .object({
    revision: z.string(),
    config: Oryn.optional(),
    repositories: z.array(z.object({ accountId: z.string(), repository: z.string() })),
    targets: z.array(Target),
  })
  .strict()
  .meta({ ref: "OrynSetupView" })

export namespace OrynSetup {
  function revision(config: Config.Info) {
    return externalIdentityHash(JSON.stringify(config.oryn ?? {}), JSON.stringify(config.channel ?? {}))
  }
  export async function targets() {
    const config = await Config.globalRaw()
    const targets: z.infer<typeof Target>[] = []
    for (const project of await ManagedProjectOwnership.listAll()) {
      if (
        project.channelType !== "feishu" ||
        project.remoteState !== "active" ||
        !config.channel?.feishu?.accounts?.[project.accountId]?.enabled
      )
        continue
      const scope = await Scope.fromID(project.scopeID)
      targets.push({
        id: externalIdentityHash(project.accountId, project.externalProjectId),
        accountId: project.accountId,
        chatId: project.externalProjectId,
        label: scope?.type === "project" ? (scope.name ?? project.externalProjectId) : project.externalProjectId,
      })
    }
    for (const id of await Storage.scan(["oryn", "channel_sources"])) {
      const source = ChannelSource.parse(await Storage.read(OrynPath.channelSource(id)))
      const identity = source.identity
      if (
        identity.provider !== "feishu" ||
        !identity.chatId ||
        !config.channel?.feishu?.accounts?.[identity.accountId]?.enabled
      )
        continue
      const parent = targets.find(
        (target) => target.accountId === identity.accountId && target.chatId === identity.chatId,
      )
      if (!parent && source.chatType !== "dm") continue
      const key = externalIdentityHash(identity.accountId, identity.chatId, identity.threadId ?? "")
      if (targets.some((target) => target.id === key)) continue
      targets.push({
        id: key,
        accountId: identity.accountId,
        chatId: identity.chatId,
        threadId: identity.threadId,
        label: `${parent?.label ?? identity.chatId} · ${identity.threadId ?? identity.chatId}`,
      })
    }
    const configured = config.oryn?.notifications?.target
    if (
      configured &&
      config.channel?.feishu?.accounts?.[configured.accountId]?.enabled &&
      !targets.some(
        (target) =>
          target.accountId === configured.accountId &&
          target.chatId === configured.chatId &&
          target.threadId === configured.threadId,
      )
    ) {
      targets.push({
        ...configured,
        id: externalIdentityHash(configured.accountId, configured.chatId, configured.threadId ?? ""),
        label: configured.threadId ? `${configured.chatId} · ${configured.threadId}` : configured.chatId,
      })
    }
    return targets
  }
  export async function view() {
    const config = await Config.globalRaw()
    return OrynSetupView.parse({
      revision: revision(config),
      config: config.oryn,
      targets: await targets(),
      repositories: Object.entries(
        ChannelGithub.parse(config.channel?.github ?? { type: "github", accounts: {} }).accounts,
      )
        .filter(([, account]) => account.enabled !== false)
        .flatMap(([accountId, account]) => account.repositories.map((repository) => ({ accountId, repository }))),
    })
  }
  export async function save(raw: OrynSetupInput) {
    const input = OrynSetupInput.parse(raw)
    using lock = await Lock.write("oryn-setup")
    const previous = await Config.globalRaw()
    if (revision(previous) !== input.revision)
      throw storeError("STALE_REVISION", "Settings changed; refresh before saving")
    if (!input.enabled && previous.oryn?.enabled) {
      const domain = await Config.domainGet("runtime")
      return Config.domainUpdateWithChange(
        "runtime",
        { ...domain, oryn: { ...previous.oryn, enabled: false } },
        { mode: "replace-domain" },
      )
    }
    const account = ChannelGithub.parse(previous.channel?.github ?? { type: "github", accounts: {} }).accounts[
      input.githubAccount
    ]
    if (!account || account.enabled === false || !account.repositories.includes(input.repository))
      throw storeError("NOT_AUTHORIZED", "Select a repository from an enabled GitHub Channel account")
    if (!path.isAbsolute(input.directory))
      throw storeError("ENVIRONMENT_UNAVAILABLE", "Repository directory must be absolute")
    const directory = await realpath(input.directory)
    const root = await realpath(await OrynGit.read(directory, ["rev-parse", "--show-toplevel"]))
    if (root !== directory) throw storeError("ENVIRONMENT_UNAVAILABLE", "Select the repository root")
    const remote = (await OrynGit.read(directory, ["remote", "get-url", "origin"])).replace(/\.git$/, "")
    if (
      ![
        `https://github.com/${input.repository}`,
        `git@github.com:${input.repository}`,
        `ssh://git@github.com/${input.repository}`,
      ].includes(remote)
    )
      throw storeError("NOT_AUTHORIZED", "Checkout origin does not match the selected repository")
    await OrynGit.read(directory, ["check-ref-format", `refs/heads/${input.baseBranch}`])
    await OrynGit.read(directory, ["rev-parse", "--verify", `refs/remotes/origin/${input.baseBranch}^{commit}`])
    const target = input.notificationTarget
      ? (await targets()).find((target) => target.id === input.notificationTarget)
      : undefined
    if (input.notificationTarget && !target)
      throw storeError("NOT_AUTHORIZED", "Notification destination is no longer available; refresh connected chats")
    const [owner, repo] = input.repository.split("/")
    const oryn = Oryn.parse({
      ...previous.oryn,
      enabled: input.enabled,
      defaultRepoAlias: input.repoAlias,
      repositories: {
        ...previous.oryn?.repositories,
        [input.repoAlias]: {
          ...previous.oryn?.repositories?.[input.repoAlias],
          owner,
          repo,
          directory,
          baseBranch: input.baseBranch,
          githubAccount: input.githubAccount,
          github: { enabled: true, backfill: input.backfill, autoReview: input.autoReview, autoFix: input.autoFix },
        },
      },
      routes: target
        ? [
            { feishuAccount: target.accountId, chats: [target.chatId], repoAlias: input.repoAlias },
            ...(previous.oryn?.routes ?? []).filter(
              (route) =>
                !(
                  route.feishuAccount === target.accountId &&
                  route.chats?.length === 1 &&
                  route.chats[0] === target.chatId
                ),
            ),
          ]
        : previous.oryn?.routes,
      notifications: {
        ...previous.oryn?.notifications,
        target: target ? { accountId: target.accountId, chatId: target.chatId, threadId: target.threadId } : undefined,
      },
    })
    const channels = structuredClone(previous.channel)
    const feishu = channels?.feishu
    if (target && feishu?.type === "feishu" && feishu.accounts[target.accountId])
      feishu.accounts[target.accountId]!.groupSessionScope = "group_thread"
    const before = await Config.globalRaw()
    if (channels) await Config.domainUpdateWithChange("channels", { channel: channels })
    const result = await Config.domainMutateWithChange("runtime", (domain) => ({ ...domain, oryn }), {
      mode: "replace-domain",
    })
    return { ...result, change: { ...result.change, changedFields: Config.diff(before, await Config.globalRaw()) } }
  }
}
