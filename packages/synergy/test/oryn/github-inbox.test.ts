import { describe, expect, test } from "bun:test"
import { OrynGithubStore } from "../../src/oryn/github-store"
import { OrynGithub } from "../../src/oryn/github"
import { OrynStore } from "../../src/oryn/store"
import { githubConfig as globalConfig } from "./fixture"

describe("Oryn GitHub durable intake", () => {
  test("backlog pages persist before checkpoint; replay binds the original issue once", async () => {
    const repository = `acme/r${crypto.randomUUID()}`
    const [owner, repo] = repository.split("/")
    await using config = await globalConfig({
      oryn: {
        enabled: true,
        repositories: {
          target: { owner, repo, githubAccount: "app", github: { enabled: true, backfill: true } },
        },
      },
    })
    const item = {
      number: 41,
      kind: "issue" as const,
      title: "Broken pagination",
      body: "The second page disappears",
      state: "open" as const,
      updatedAt: "2026-09-08T00:00:00Z",
      labels: [],
      comments: [],
    }
    let pages = 0
    const transport = { page: async () => ({ items: [item], nextPage: ++pages === 1 ? 2 : undefined }) }
    await OrynGithub.scan({ accountId: "app", repository, transport })
    expect((await OrynGithubStore.cursor("app", repository))?.page).toBe(2)
    await OrynGithub.scan({ accountId: "app", repository, transport })
    const work = await OrynGithubStore.list()
    const matched = work.filter((x) => x.repository === repository)
    expect(matched).toHaveLength(1)
    const record = await OrynStore.getCase(matched[0]!.caseId)
    expect(record?.issueNumber).toBe(41)
    expect(record?.summary).toBe("Broken pagination")
    expect((await OrynGithubStore.cursor("app", repository))?.page).toBe(1)
  })

  test("disabled or unbound repositories cannot accept GitHub work", async () => {
    await using config = await globalConfig({ oryn: { enabled: false } })
    let calls = 0
    expect(
      await OrynGithub.scan({
        accountId: "app",
        repository: "acme/other",
        transport: {
          page: async () => {
            calls++
            return { items: [] }
          },
        },
      }),
    ).toBe(false)
    expect(calls).toBe(0)
  })

  test("a failed page does not advance its checkpoint and retry retains already admitted items", async () => {
    const repo = `r${crypto.randomUUID()}`
    const repository = `acme/${repo}`
    await using config = await globalConfig({
      oryn: {
        enabled: true,
        repositories: { target: { owner: "acme", repo, githubAccount: "app", github: { enabled: true } } },
      },
    })
    const item = {
      number: 1,
      kind: "issue" as const,
      title: "First",
      body: "Evidence",
      state: "open" as const,
      updatedAt: new Date().toISOString(),
      labels: [],
      comments: [],
    }
    const transport = { page: async () => ({ items: [item, { ...item, number: -1 }] }) }
    await expect(OrynGithub.scan({ accountId: "app", repository, transport })).rejects.toBeDefined()
    expect(await OrynGithubStore.cursor("app", repository)).toMatchObject({ page: 1, initialized: false })
    await OrynGithub.scan({ accountId: "app", repository, transport: { page: async () => ({ items: [item] }) } })
    expect((await OrynGithubStore.list()).filter((work) => work.repository === repository)).toHaveLength(1)
  })

  test("the same issue number in two repositories has distinct source identity; bot replies do not reopen work", async () => {
    const suffix = crypto.randomUUID()
    await using config = await globalConfig({
      oryn: {
        enabled: true,
        repositories: Object.fromEntries(
          ["one", "two"].map((name) => [
            name,
            { owner: "acme", repo: name + suffix, githubAccount: "app", github: { enabled: true } },
          ]),
        ),
      },
    })
    const snapshot = {
      number: 9,
      kind: "issue" as const,
      title: "Report",
      body: "Evidence",
      state: "open" as const,
      updatedAt: new Date().toISOString(),
      labels: [],
      comments: [],
    }
    const first = (await OrynGithub.accept({
      accountId: "app",
      repoAlias: "one",
      repository: `acme/one${suffix}`,
      snapshot,
    }))!
    const second = await OrynGithub.accept({
      accountId: "app",
      repoAlias: "two",
      repository: `acme/two${suffix}`,
      snapshot,
    })
    expect(first).not.toBe(second)
    await OrynGithubStore.save({ ...(await OrynGithubStore.get(first))!, state: "settled" })
    await OrynGithub.accept({
      accountId: "app",
      repoAlias: "one",
      repository: `acme/one${suffix}`,
      snapshot: {
        ...snapshot,
        comments: [{ id: 1, login: "oryn[bot]", bot: true, body: "Answer", updatedAt: snapshot.updatedAt }],
      },
    })
    expect((await OrynGithubStore.get(first))?.state).toBe("settled")
  })
})

test("closing and reopening a thread resumes observation, while explicit stop and revoked accounts stay stopped", async () => {
  const repository = `acme/r${crypto.randomUUID()}`
  await using config = await globalConfig({
    oryn: {
      enabled: true,
      repositories: {
        target: { owner: "acme", repo: repository.split("/")[1], githubAccount: "app", github: { enabled: true } },
      },
    },
  })
  const snapshot = {
    number: 6,
    kind: "issue" as const,
    title: "Reopen",
    body: "Evidence",
    state: "open" as const,
    updatedAt: new Date().toISOString(),
    labels: [],
    comments: [],
  }
  const input = { accountId: "app", repository, repoAlias: "target" }
  const id = (await OrynGithub.accept({ ...input, snapshot }))!
  await OrynGithub.accept({ ...input, snapshot: { ...snapshot, state: "closed" } })
  await OrynGithub.accept({ ...input, snapshot })
  expect((await OrynGithubStore.get(id))?.state).toBe("queued")
  await OrynGithubStore.save({ ...(await OrynGithubStore.get(id))!, state: "stopped", stoppedBy: "command" })
  await OrynGithub.accept({ ...input, snapshot })
  expect((await OrynGithubStore.get(id))?.state).toBe("stopped")
  const { Config } = await import("../../src/config/config")
  await Config.domainUpdate("channels", { channel: {} }, { mode: "replace-domain" })
  expect(await OrynGithub.binding("app", repository)).toBeUndefined()
})
