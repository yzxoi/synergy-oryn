import { ChannelFeishu, ChannelGithub } from "../../src/config/schema"
import { expect, test } from "bun:test"
import { OrynSetup } from "../../src/oryn/setup"
import { Config } from "../../src/config/config"
import { OrynGit } from "../../src/oryn/git"
import { globalConfig, tmpdir } from "./fixture"

test("setup discovers configured repositories while disabled, validates checkout, preserves policy and rejects stale saves", async () => {
  await using repo = await tmpdir({ git: true })
  await Bun.$`git remote add origin https://github.com/acme/widget.git`.cwd(repo.path).quiet()
  const head = await OrynGit.read(repo.path, ["rev-parse", "HEAD"])
  await Bun.$`git update-ref refs/remotes/origin/dev ${head}`.cwd(repo.path).quiet()
  await using config = await globalConfig({
    channel: {
      github: ChannelGithub.parse({
        type: "github",
        accounts: { app: { enabled: true, repositories: ["acme/widget"], workspaceDir: repo.path } },
      }),
    },
    oryn: {
      enabled: false,
      limits: { maxActiveCases: 2 },
      notifications: { target: { accountId: "old", chatId: "old-chat" } },
    },
  })
  const view = await OrynSetup.view()
  expect(view.repositories).toEqual([{ accountId: "app", repository: "acme/widget" }])
  const input = {
    revision: view.revision,
    enabled: false,
    repoAlias: "widget",
    githubAccount: "app",
    repository: "acme/widget",
    directory: repo.path,
    baseBranch: "dev",
    backfill: true,
    autoReview: true,
    autoFix: false,
  }
  await expect(OrynSetup.save({ ...input, repository: "acme/untrusted" })).rejects.toBeDefined()
  await expect(OrynSetup.save({ ...input, notificationTarget: "unknown" })).rejects.toBeDefined()
  await OrynSetup.save(input)
  const stored = (await Config.globalRaw()).oryn
  expect(stored?.enabled).toBe(false)
  expect(stored?.limits?.maxActiveCases).toBe(2)
  expect(stored?.notifications?.target).toBeUndefined()
  expect(stored?.repositories?.widget?.github).toEqual({
    enabled: true,
    backfill: true,
    autoReview: true,
    autoFix: false,
  })
  await expect(OrynSetup.save(input)).rejects.toBeDefined()
  await OrynSetup.save({ ...input, enabled: true, revision: (await OrynSetup.view()).revision })
  await OrynSetup.save({
    ...input,
    enabled: false,
    directory: "/unavailable-checkout",
    revision: (await OrynSetup.view()).revision,
  })
  expect((await Config.globalRaw()).oryn?.enabled).toBe(false)
})

test("empty installation setup is readable without credentials", async () => {
  await using config = await globalConfig({ channel: {}, oryn: { enabled: false } })
  const view = await OrynSetup.view()
  expect(view.repositories).toEqual([])
  expect(JSON.stringify(view)).not.toContain("appSecret")
})

test("setup retains the configured direct-chat destination before conversation discovery", async () => {
  await using repo = await tmpdir({ git: true })
  await Bun.$`git remote add origin https://github.com/acme/widget.git`.cwd(repo.path).quiet()
  const head = await OrynGit.read(repo.path, ["rev-parse", "HEAD"])
  await Bun.$`git update-ref refs/remotes/origin/dev ${head}`.cwd(repo.path).quiet()
  await using config = await globalConfig({
    channel: {
      github: ChannelGithub.parse({
        type: "github",
        accounts: { app: { enabled: true, repositories: ["acme/widget"], workspaceDir: repo.path } },
      }),
      feishu: ChannelFeishu.parse({
        type: "feishu",
        accounts: { qa: { enabled: true, appId: "fixture", appSecret: "fixture" } },
      }),
    },
    oryn: { enabled: false, notifications: { target: { accountId: "qa", chatId: "direct-chat" } } },
  })
  const view = await OrynSetup.view()
  expect(view.targets).toContainEqual(expect.objectContaining({ accountId: "qa", chatId: "direct-chat" }))
  expect(view.targets.filter((target) => target.chatId === "direct-chat")).toHaveLength(1)
  expect(JSON.stringify(view.targets)).not.toContain("appSecret")
  await OrynSetup.save({
    revision: view.revision,
    enabled: false,
    repoAlias: "widget",
    githubAccount: "app",
    repository: "acme/widget",
    directory: repo.path,
    baseBranch: "dev",
    backfill: false,
    autoReview: true,
    autoFix: false,
    notificationTarget: view.targets.find((target) => target.chatId === "direct-chat")!.id,
  })
  expect((await Config.globalRaw()).oryn?.notifications?.target).toEqual({ accountId: "qa", chatId: "direct-chat" })
})
