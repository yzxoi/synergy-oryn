import { ChannelGithub } from "../../src/config/schema"
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
    enabled: true,
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
  expect(stored?.limits?.maxActiveCases).toBe(2)
  expect(stored?.notifications?.target).toBeUndefined()
  expect(stored?.repositories?.widget?.github).toEqual({
    enabled: true,
    backfill: true,
    autoReview: true,
    autoFix: false,
  })
  await expect(OrynSetup.save(input)).rejects.toBeDefined()
})

test("empty installation setup is readable without credentials", async () => {
  await using config = await globalConfig({ channel: {}, oryn: { enabled: false } })
  const view = await OrynSetup.view()
  expect(view.repositories).toEqual([])
  expect(JSON.stringify(view)).not.toContain("appSecret")
})
