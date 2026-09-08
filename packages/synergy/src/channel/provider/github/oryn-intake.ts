import { GitHubChannelAuth, type RequestDescriptor } from "./api"
import { GithubSnapshot } from "../../../oryn/github-store"
import type { OrynGithub } from "../../../oryn/github"

export namespace OrynGithubIntake {
  async function descriptor(repository: string, suffix: string, signal?: AbortSignal): Promise<RequestDescriptor> {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(repository))
      throw new Error("Invalid repository")
    const [owner, repo] = repository.split("/")
    const token = await GitHubChannelAuth.resolveInstallationToken(owner!, repo!, signal)
    return {
      url: `https://api.github.com/repos/${repository}/${suffix}`,
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "synergy-oryn",
      },
    }
  }
  export async function read<T>(repository: string, suffix: string, signal?: AbortSignal): Promise<T> {
    return GitHubChannelAuth.GitHubClient.send<T>(await descriptor(repository, suffix, signal), signal)
  }
  export async function write<T>(repository: string, suffix: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return GitHubChannelAuth.GitHubClient.send<T>(
      { ...(await descriptor(repository, suffix, signal)), method: "POST", body: JSON.stringify(body) },
      signal,
    )
  }
  type Comment = {
    id: number
    body?: string
    user: { login: string; type: string }
    updated_at?: string
    submitted_at?: string
    state?: string
    path?: string
    line?: number
  }
  type Issue = {
    number: number
    title: string
    body?: string
    state: "open" | "closed"
    updated_at: string
    comments: number
    labels: Array<{ name: string }>
    pull_request?: unknown
  }
  type Pull = Issue & {
    draft: boolean
    merged: boolean
    head: { sha: string }
    base: { sha: string; ref: string; repo: { full_name: string } }
  }
  export async function snapshot(repository: string, issue: Issue, signal?: AbortSignal): Promise<GithubSnapshot> {
    const pull = issue.pull_request ? await read<Pull>(repository, `pulls/${issue.number}`, signal) : undefined
    if (pull && pull.base.repo.full_name.toLowerCase() !== repository.toLowerCase())
      throw new Error("PR target repository changed")
    const comments = await read<Comment[]>(
      repository,
      `issues/${issue.number}/comments?per_page=100&page=${Math.max(1, Math.ceil(issue.comments / 100))}`,
      signal,
    )
    const latest = async (suffix: string, query = "") => {
      const first = await GitHubChannelAuth.GitHubClient.sendPage<Comment[]>(
        await descriptor(repository, `${suffix}?per_page=100${query}`, signal),
        signal,
      )
      const last = first.headers.get("link")?.match(/<([^>]+)>; rel="last"/)
      const page = last ? Number(new URL(last[1]!).searchParams.get("page")) : undefined
      if (page && page > 1) return read<Comment[]>(repository, `${suffix}?per_page=100&page=${page}${query}`, signal)
      if (first.headers.get("link")?.includes('rel="next"') && !page) throw new Error("Incomplete review pagination")
      return first.data
    }
    const reviews = pull ? await latest(`pulls/${issue.number}/reviews`) : []
    const inline = pull ? await latest(`pulls/${issue.number}/comments`, "&sort=updated&direction=asc") : []
    return GithubSnapshot.parse({
      number: issue.number,
      kind: pull ? "pull" : "issue",
      title: issue.title.slice(0, 2000),
      body: (issue.body ?? "").slice(0, 20000),
      state: issue.state,
      updatedAt: issue.updated_at,
      labels: issue.labels.map((label) => label.name).slice(0, 100),
      ...(pull
        ? {
            draft: pull.draft,
            merged: pull.merged,
            headSha: pull.head.sha,
            baseSha: pull.base.sha,
            baseRef: pull.base.ref,
          }
        : {}),
      comments: [
        ...comments,
        ...reviews.map((item) => ({
          ...item,
          id: -item.id * 2,
          body: item.state ? `Review ${item.state}\n${item.body ?? ""}` : item.body,
        })),
        ...inline.map((item) => ({
          ...item,
          id: -item.id * 2 - 1,
          body: `${item.path ?? ""}${item.line ? `:${item.line}` : ""}\n${item.body ?? ""}`,
        })),
      ]
        .sort((a, b) => (a.updated_at ?? a.submitted_at ?? "").localeCompare(b.updated_at ?? b.submitted_at ?? ""))
        .slice(-100)
        .map((comment) => ({
          id: comment.id,
          body: (comment.body ?? "").slice(0, 10000),
          login: comment.user.login,
          bot: comment.user.type === "Bot",
          updatedAt: comment.updated_at ?? comment.submitted_at ?? issue.updated_at,
        })),
    })
  }
  export const current = async (repository: string, number: number, signal?: AbortSignal) =>
    snapshot(repository, await read<Issue>(repository, `issues/${number}`, signal), signal)
  export function createTransport(): OrynGithub.PageTransport {
    return {
      current,
      async page(input) {
        const query = new URLSearchParams({
          state: input.state ?? "all",
          sort: "updated",
          direction: "asc",
          per_page: "20",
          page: String(input.page),
        })
        if (input.state !== "open") query.set("since", input.since)
        const response = await GitHubChannelAuth.GitHubClient.sendPage<Issue[]>(
          await descriptor(input.repository, `issues?${query}`, input.signal),
          input.signal,
        )
        const items: GithubSnapshot[] = []
        for (const issue of response.data) items.push(await snapshot(input.repository, issue, input.signal))
        return { items, nextPage: response.headers.get("link")?.includes('rel="next"') ? input.page + 1 : undefined }
      },
    }
  }
}
