import { afterEach, expect, spyOn, test } from "bun:test"
import { GitHubChannelAuth } from "../../../../src/channel/provider/github/api"
import { OrynGithubLabels } from "../../../../src/channel/provider/github/labels"
import type { LabelRead } from "../../../../src/oryn/labels"

const input: LabelRead = {
  repository: "acme/widget",
  number: 55,
  kind: "pull",
  candidateSha: "a".repeat(40),
  baseBranch: "dev",
  marker: "<!-- oryn:fixture -->",
  branch: "codex/oryn/fixture",
  labels: ["oryn:type/bug", "oryn:status/coding", "oryn:priority/untriaged"],
}
const restore: Array<() => void> = []
afterEach(() => {
  for (const fn of restore.splice(0).reverse()) fn()
})
function fixture(login = "oryn-app[bot]") {
  const token = spyOn(GitHubChannelAuth, "resolveInstallationToken").mockResolvedValue("fixture-token")
  const slug = spyOn(GitHubChannelAuth, "getAppSlug").mockResolvedValue("oryn-app")
  const state = {
    labels: ["human", "oryn:type/feature", "oryn:status/triage", "oryn:priority/p1"],
    writes: [] as Array<{ method: string; path: string; body?: unknown }>,
  }
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (url: URL | RequestInfo, init?: RequestInit) => {
        const path = new URL(String(url)).pathname
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { labels: string[] }
          state.writes.push({ method: "POST", path, body })
          state.labels = [...new Set([...state.labels, ...body.labels])]
          return Response.json(state.labels.map((name) => ({ name })))
        }
        if (init?.method === "DELETE") {
          state.writes.push({ method: "DELETE", path })
          state.labels = state.labels.filter((name) => name !== decodeURIComponent(path.split("/").at(-1)!))
          return Response.json(state.labels.map((name) => ({ name })))
        }
        if (path.endsWith("/pulls/55"))
          return Response.json({
            number: 55,
            state: "open",
            user: { login },
            body: input.marker,
            head: { sha: input.candidateSha, ref: input.branch, repo: { full_name: input.repository } },
            base: { ref: "dev", repo: { full_name: input.repository } },
          })
        if (path.endsWith("/labels")) {
          const page = Number(new URL(String(url)).searchParams.get("page") ?? 1)
          return Response.json(state.labels.slice((page - 1) * 100, page * 100).map((name) => ({ name })))
        }
        throw new Error(`Unexpected request ${path}`)
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  )
  restore.push(
    () => token.mockRestore(),
    () => slug.mockRestore(),
    () => fetch.mockRestore(),
  )
  return state
}

test("label transport adds and removes owned labels without replacing human labels or priority", async () => {
  const state = fixture()
  const transport = OrynGithubLabels.createTransport()
  expect((await transport.observe(input)).owned).toBe(true)
  await transport.apply({
    ...input,
    add: input.labels,
    remove: ["oryn:type/feature", "oryn:status/triage"],
    beforeWrite: async () => {},
  })
  expect(state.labels.sort()).toEqual(["human", "oryn:priority/p1", "oryn:type/bug", "oryn:status/coding"].sort())
  expect(state.writes.some((write) => write.method === "PUT")).toBe(false)
  expect(state.writes.find((write) => write.method === "DELETE")?.path).toContain("oryn%3A")
  const count = state.writes.length
  await transport.apply({ ...input, add: input.labels, remove: [], beforeWrite: async () => {} })
  expect(state.writes).toHaveLength(count)
})

test("a copied marker with a foreign App login does not authorize label changes", async () => {
  const state = fixture("other-app[bot]")
  const transport = OrynGithubLabels.createTransport()
  expect((await transport.observe(input)).owned).toBe(false)
  await expect(
    transport.apply({ ...input, add: input.labels, remove: [], beforeWrite: async () => {} }),
  ).rejects.toThrow()
  expect(state.writes).toHaveLength(0)
})

test("host cancellation is checked before the first label mutation", async () => {
  const state = fixture()
  await expect(
    OrynGithubLabels.createTransport().apply({
      ...input,
      add: input.labels,
      remove: [],
      beforeWrite: async () => {
        throw new Error("cancelled")
      },
    }),
  ).rejects.toThrow("cancelled")
  expect(state.writes).toHaveLength(0)
})

test("human priority beyond the first page is preserved", async () => {
  const state = fixture()
  state.labels = [...Array.from({ length: 100 }, (_, index) => `human-${index}`), "oryn:priority/p0"]
  const transport = OrynGithubLabels.createTransport()
  expect((await transport.observe(input)).labels).toHaveLength(101)
  await transport.apply({ ...input, add: input.labels, remove: [], beforeWrite: async () => {} })
  expect(state.labels).toContain("oryn:priority/p0")
  expect(state.labels).not.toContain("oryn:priority/untriaged")
  expect(state.labels.filter((label) => label.startsWith("human-"))).toHaveLength(100)
})
