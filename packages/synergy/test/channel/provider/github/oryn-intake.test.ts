import { expect, spyOn, test } from "bun:test"
import { GitHubChannelAuth } from "../../../../src/channel/provider/github/api"
import { OrynGithubIntake } from "../../../../src/channel/provider/github/oryn-intake"

test("backfill reads all open issues without a timestamp filter while incremental scans preserve their watermark", async () => {
  const auth = spyOn(GitHubChannelAuth, "resolveInstallationToken").mockResolvedValue("fixture-token")
  const requested: URL[] = []
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (url: URL | RequestInfo) => {
        const parsed = new URL(String(url))
        requested.push(parsed)
        if (parsed.pathname.endsWith("/comments")) return Response.json([])
        if (parsed.searchParams.get("since")?.startsWith("1970-")) return Response.json([])
        return Response.json(
          [
            {
              number: 7,
              title: "Existing issue",
              body: "Bug",
              state: "open",
              updated_at: "2026-09-08T01:00:00Z",
              comments: 0,
              labels: [],
            },
          ],
          { headers: { link: '<https://api.github.com/repos/acme/widget/issues?state=open&page=2>; rel="next"' } },
        )
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  )
  try {
    const transport = OrynGithubIntake.createTransport()
    const backlog = await transport.page({
      repository: "acme/widget",
      page: 1,
      state: "open",
      since: new Date(0).toISOString(),
    })
    expect(backlog.items.map((item) => item.number)).toEqual([7])
    expect(backlog.nextPage).toBe(2)
    expect(requested[0]!.searchParams.has("since")).toBe(false)
    const since = "2026-09-08T01:00:00.000Z"
    await transport.page({ repository: "acme/widget", page: 2, state: "all", since })
    expect(requested.find((url) => url.searchParams.get("state") === "all")?.searchParams.get("since")).toBe(since)
  } finally {
    fetch.mockRestore()
    auth.mockRestore()
  }
})

test("intake reads latest review and inline-comment pages with bound credentials and preserves recent maintainer commands", async () => {
  const auth = spyOn(GitHubChannelAuth, "resolveInstallationToken").mockResolvedValue("fixture-token")
  const requested: string[] = []
  const comment = (id: number, body: string) => ({
    id,
    body,
    user: { login: "maintainer", type: "User" },
    updated_at: "2026-09-08T01:00:00Z",
  })
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (url: URL | RequestInfo, init?: RequestInit) => {
        const parsed = new URL(String(url))
        const route = parsed.pathname
        requested.push(parsed.pathname + parsed.search)
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token")
        if (route.endsWith("/pulls/7"))
          return Response.json({
            draft: false,
            merged: false,
            head: { sha: "b".repeat(40) },
            base: { sha: "a".repeat(40), ref: "dev", repo: { full_name: "acme/widget" } },
          })
        if (route.endsWith("/issues/7/comments")) return Response.json([comment(1, "@oryn fix")])
        if (route.endsWith("/pulls/7/reviews"))
          return parsed.searchParams.get("page") === "2"
            ? Response.json([{ ...comment(202, "Newest review"), state: "CHANGES_REQUESTED" }])
            : Response.json([comment(2, "Old review")], {
                headers: {
                  link: '<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=2>; rel="last", <https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=2>; rel="next"',
                },
              })
        if (route.endsWith("/pulls/7/comments"))
          return Response.json([{ ...comment(3, "The missing await loses writes"), path: "widget.ts", line: 9 }])
        throw new Error("Unexpected fixture request")
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  )
  try {
    const snapshot = await OrynGithubIntake.snapshot("acme/widget", {
      number: 7,
      title: "Widget",
      body: "Change",
      state: "open",
      updated_at: "2026-09-08T01:00:00Z",
      comments: 101,
      labels: [],
      pull_request: {},
    })
    expect(snapshot.comments.map((item) => item.body)).toEqual([
      "@oryn fix",
      "Review CHANGES_REQUESTED\nNewest review",
      "widget.ts:9\nThe missing await loses writes",
    ])
    expect(requested.some((route) => route.includes("issues/7/comments?per_page=100&page=2"))).toBe(true)
    expect(snapshot.headSha).toBe("b".repeat(40))
  } finally {
    fetch.mockRestore()
    auth.mockRestore()
  }
})
