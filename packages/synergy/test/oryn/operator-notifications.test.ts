import { expect, test } from "bun:test"
import { Config } from "../../src/config/config"
import { OrynGithub } from "../../src/oryn/github"
import { OrynService } from "../../src/oryn/service"
import { OrynStore } from "../../src/oryn/store"
import { githubConfig } from "./fixture"

test("GitHub handoffs notify the selected operator once and suppress unsent notices to a replaced target", async () => {
  const repo = `r${crypto.randomUUID()}`
  await using config = await githubConfig({
    oryn: {
      enabled: true,
      notifications: { target: { accountId: "feishu", chatId: "old-chat" } },
      repositories: { target: { owner: "acme", repo, githubAccount: "app", github: { enabled: true } } },
    },
  })
  const caseId = (await OrynGithub.accept({
    accountId: "app",
    repoAlias: "target",
    repository: `acme/${repo}`,
    snapshot: {
      number: 4,
      kind: "issue",
      title: "Missing reproduction",
      body: "It fails",
      state: "open",
      updatedAt: new Date().toISOString(),
      labels: [],
      comments: [],
    },
  }))!
  await OrynStore.requestHandoff(caseId, "Provide the missing reproduction steps.")
  await OrynService.recoverHandoffs()
  const previous = await Config.globalRaw()
  await Config.domainUpdate("runtime", {
    oryn: { ...previous.oryn, notifications: { target: { accountId: "feishu", chatId: "new-chat" } } },
  })
  await OrynService.recoverHandoffs()
  const delivered: Array<{ chatId?: string; text: string }> = []
  OrynService.setOutboxDeliverer(
    async (input) => {
      delivered.push({ chatId: input.identity.chatId, text: input.text })
    },
    async () => true,
  )
  try {
    await OrynService.drainOutbox()
    await OrynService.drainOutbox()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.chatId).toBe("new-chat")
    expect(delivered[0]?.text).toContain(`https://github.com/acme/${repo}/issues/4`)
    expect(delivered[0]?.text).toContain("Missing reproduction")
  } finally {
    OrynService.setOutboxDeliverer(undefined)
  }
})

test("recovery groups equal environment failures into one delivered operator notice", async () => {
  const repo = `r${crypto.randomUUID()}`
  await using config = await githubConfig({
    oryn: {
      enabled: true,
      notifications: { target: { accountId: "feishu", chatId: repo } },
      repositories: { target: { owner: "acme", repo, githubAccount: "app", github: { enabled: true } } },
    },
  })
  const reason = `Dependency environment unavailable (${repo})`
  for (const number of [11, 12]) {
    const caseId = (await OrynGithub.accept({
      accountId: "app",
      repoAlias: "target",
      repository: `acme/${repo}`,
      snapshot: {
        number,
        kind: "issue",
        title: "Dependency fixture",
        body: "Failure",
        state: "open",
        updatedAt: new Date().toISOString(),
        labels: [],
        comments: [],
      },
    }))!
    await OrynStore.requestHandoff(caseId, reason)
  }
  const delivered: string[] = []
  OrynService.setOutboxDeliverer(
    async (input) => {
      if (input.text.includes(reason)) delivered.push(input.text)
    },
    async () => true,
  )
  try {
    await OrynService.recoverHandoffs()
    await OrynService.recoverHandoffs()
    await OrynService.drainOutbox()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toContain("Affected tasks: 2")
    expect(delivered[0]).toContain(`/issues/11`)
    expect(delivered[0]).toContain(`/issues/12`)
  } finally {
    OrynService.setOutboxDeliverer(undefined)
  }
})
