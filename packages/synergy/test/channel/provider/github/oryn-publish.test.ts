import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { GitHubChannelAuth } from "../../../../src/channel/provider/github/api"
import { OrynGithubPublish } from "../../../../src/channel/provider/github/publish"
import type { PublishExecuteInput } from "../../../../src/oryn/publish"

const input: PublishExecuteInput = {
  operation: "mark_ready",
  repository: "acme/widget",
  pullNumber: 55,
  candidateSha: "a".repeat(40),
  branch: "codex/oryn/example",
  baseBranch: "dev",
  marker: "<!-- oryn:example -->",
}

const restorers: Array<() => void> = []
afterEach(() => {
  for (const restore of restorers.splice(0).reverse()) restore()
})

function remote(
  options: {
    draft?: boolean
    head?: string
    login?: string
    mutation?: unknown
    loseResponse?: boolean
    status?: unknown
    checks?: unknown[]
    checkPages?: unknown[][]
  } = {},
) {
  const token = spyOn(GitHubChannelAuth, "resolveInstallationToken").mockResolvedValue("fixture-token")
  const slug = spyOn(GitHubChannelAuth, "getAppSlug").mockResolvedValue("oryn-app")
  restorers.push(
    () => token.mockRestore(),
    () => slug.mockRestore(),
  )
  const writes: Array<{ path: string; body: Record<string, unknown> }> = []
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (url: URL | RequestInfo, init?: RequestInit) => {
        const path = new URL(String(url)).pathname
        if (init?.method === "POST") {
          writes.push({ path, body: JSON.parse(String(init.body)) })
          if (path === "/graphql") {
            if (options.loseResponse) throw new TypeError("connection lost after remote write")
            return Response.json(
              options.mutation ?? {
                data: {
                  markPullRequestReadyForReview: {
                    pullRequest: {
                      id: "PR_fixture",
                      number: 55,
                      isDraft: false,
                      state: "OPEN",
                      headRefOid: input.candidateSha,
                      headRefName: input.branch,
                      baseRefName: "dev",
                      url: "https://github.com/acme/widget/pull/55",
                    },
                  },
                },
              },
            )
          }
          if (path.endsWith("/check-runs")) return Response.json({ id: 99 })
          throw new Error(`Unexpected write: ${path}`)
        }
        if (path.endsWith("/pulls/55"))
          return Response.json({
            node_id: "PR_fixture",
            number: 55,
            draft: options.draft ?? true,
            state: "open",
            head: { sha: options.head ?? input.candidateSha, ref: input.branch, repo: { full_name: input.repository } },
            base: { ref: "dev", repo: { full_name: input.repository } },
            user: { login: options.login ?? "oryn-app[bot]" },
            body: input.marker,
            html_url: "https://github.com/acme/widget/pull/55",
          })
        if (path.endsWith("/status"))
          return Response.json(options.status ?? { state: "pending", total_count: 0, statuses: [] })
        if (path.endsWith("/check-runs")) {
          const page = Number(new URL(String(url)).searchParams.get("page") ?? 1)
          const pages = options.checkPages
          return Response.json(
            {
              total_count: pages?.flat().length ?? options.checks?.length ?? 0,
              check_runs: pages ? pages[page - 1] : (options.checks ?? []),
            },
            {
              headers:
                pages && page < pages.length
                  ? { link: `<https://api.github.com${path}?page=${page + 1}>; rel="next"` }
                  : {},
            },
          )
        }
        throw new Error(`Unexpected read: ${path}`)
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  )
  restorers.push(() => fetchSpy.mockRestore())
  return { writes }
}

describe("Oryn GitHub ready transport", () => {
  test("changes Draft to ready even when the optional delivery check is disabled", async () => {
    const network = remote()
    const result = await OrynGithubPublish.createTransport().execute(input)
    expect(network.writes.map((write) => write.path)).toEqual(["/graphql"])
    expect(network.writes[0]!.body.variables).toEqual({ input: { pullRequestId: "PR_fixture" } })
    expect(result.refs).toMatchObject({ pullNumber: 55, url: "https://github.com/acme/widget/pull/55" })
  })

  test("writes the configured check only after the matching candidate becomes ready", async () => {
    const network = remote()
    const result = await OrynGithubPublish.createTransport().execute({ ...input, deliveryCheckEnabled: true })
    expect(network.writes.map((write) => write.path)).toEqual(["/graphql", "/repos/acme/widget/check-runs"])
    expect(network.writes[1]!.body).toMatchObject({ name: "oryn/delivery", head_sha: input.candidateSha })
    expect(result.refs).toMatchObject({ pullNumber: 55, checkRunId: 99 })
  })

  test("already-ready PR requires no repeated mutation", async () => {
    const network = remote({ draft: false })
    expect((await OrynGithubPublish.createTransport().execute(input)).refs.pullNumber).toBe(55)
    expect(network.writes).toHaveLength(0)
  })

  test("rejects a changed candidate before writing", async () => {
    const network = remote({ head: "b".repeat(40) })
    await expect(OrynGithubPublish.createTransport().execute(input)).rejects.toThrow()
    expect(network.writes).toHaveLength(0)
  })

  test("rejects another bot even when it copies the case marker", async () => {
    const network = remote({ login: "unrelated[bot]" })
    await expect(OrynGithubPublish.createTransport().execute(input)).rejects.toThrow()
    expect(network.writes).toHaveLength(0)
  })

  test("HTTP 200 with GraphQL errors cannot acknowledge readiness", async () => {
    const network = remote({ mutation: { errors: [{ message: "not authorized" }] } })
    await expect(
      OrynGithubPublish.createTransport().execute({ ...input, deliveryCheckEnabled: true }),
    ).rejects.toThrow()
    expect(network.writes.map((write) => write.path)).toEqual(["/graphql"])
  })

  test("a changed head in the mutation response never earns a delivery check", async () => {
    const network = remote({
      mutation: {
        data: {
          markPullRequestReadyForReview: {
            pullRequest: {
              id: "PR_fixture",
              number: 55,
              isDraft: false,
              state: "OPEN",
              headRefOid: "b".repeat(40),
            },
          },
        },
      },
    })
    await expect(
      OrynGithubPublish.createTransport().execute({ ...input, deliveryCheckEnabled: true }),
    ).rejects.toThrow()
    expect(network.writes.map((write) => write.path)).toEqual(["/graphql"])
  })

  test("lost mutation response remains uncertain instead of reporting a rejected action", async () => {
    remote({ loseResponse: true })
    await expect(OrynGithubPublish.createTransport().execute(input)).rejects.toMatchObject({ name: "GitHubApiError" })
  })

  test("observation exposes draft state and checks the configured App identity", async () => {
    remote({ login: "unrelated[bot]", draft: true })
    const facts = await OrynGithubPublish.createTransport().observe({
      repository: input.repository,
      pullNumber: 55,
      marker: input.marker,
    })
    expect(facts.pull).toMatchObject({ draft: true, authorIsApp: false, markerPresent: true })
  })
})

describe("Oryn CI observation", () => {
  test("a successful check is not blocked by GitHub's empty combined-status pending default", async () => {
    remote({ checks: [{ id: 10, name: "test", status: "completed", conclusion: "success" }] })
    const facts = await OrynGithubPublish.createTransport().observe({
      repository: input.repository,
      ref: input.candidateSha,
    })
    expect(facts.ci.state).toBe("success")
  })

  test("a running check blocks readiness even beside a successful status", async () => {
    remote({
      status: { state: "success", total_count: 1 },
      checks: [{ name: "test", status: "in_progress", conclusion: null }],
    })
    const facts = await OrynGithubPublish.createTransport().observe({
      repository: input.repository,
      ref: input.candidateSha,
    })
    expect(facts.ci.state).toBe("pending")
  })

  test("the App's delivery check cannot certify itself as independent CI", async () => {
    remote({
      checks: [
        {
          id: 99,
          name: "oryn/delivery",
          head_sha: input.candidateSha,
          app: { slug: "oryn-app" },
          status: "completed",
          conclusion: "success",
        },
      ],
    })
    const facts = await OrynGithubPublish.createTransport().observe({
      repository: input.repository,
      ref: input.candidateSha,
    })
    expect(facts.ci.state).toBe("none")
    expect(facts.delivery).toMatchObject({ checkRunId: 99, headSha: input.candidateSha! })
  })

  test("another App cannot forge the delivery receipt", async () => {
    remote({
      checks: [
        {
          id: 99,
          name: "oryn/delivery",
          head_sha: input.candidateSha,
          app: { slug: "other" },
          status: "completed",
          conclusion: "success",
        },
      ],
    })
    const facts = await OrynGithubPublish.createTransport().observe({
      repository: input.repository,
      ref: input.candidateSha,
    })
    expect(facts.delivery).toBeUndefined()
  })
})

test("Oryn CI includes unfinished jobs beyond the first check page", async () => {
  remote({
    checkPages: [
      [{ name: "first", status: "completed", conclusion: "success" }],
      [{ name: "last", status: "queued", conclusion: null }],
    ],
  })
  const facts = await OrynGithubPublish.createTransport().observe({
    repository: input.repository,
    ref: input.candidateSha,
  })
  expect(facts.ci.state).toBe("pending")
})
