import { expect, test } from "bun:test"
import { ChannelHost } from "../../src/channel/host"
import { ManagedProjectOwnership } from "../../src/channel/managed-project-ownership"
import { refreshFeishuProjects } from "../../src/channel/provider/feishu/projects"

test("Feishu discovery reconciles every page and archives absent groups only after completion", async () => {
  const host = ChannelHost.create({ channelType: "feishu", accountId: crypto.randomUUID() })
  await host.projects.ensure({ externalProjectId: "old", name: "Old", isActive: true })
  const pages: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      expect(request.headers.get("Authorization")).toBe("Bearer fixture")
      const token = new URL(request.url).searchParams.get("page_token") ?? ""
      pages.push(token)
      return Response.json({
        code: 0,
        data: {
          items: [{ chat_id: token ? "second" : "first", name: token || "First" }],
          has_more: !token,
          page_token: token ? "" : "next",
        },
      })
    },
  })
  try {
    await refreshFeishuProjects({
      apiBase: server.url.href.replace(/\/$/, ""),
      getAccessToken: async () => "fixture",
      signal: new AbortController().signal,
      host,
    })
    expect(pages).toEqual(["", "next"])
    for (const externalProjectId of ["first", "second"]) {
      expect(
        await ManagedProjectOwnership.find({ channelType: "feishu", accountId: host.accountId, externalProjectId }),
      ).toMatchObject({ remoteState: "active" })
    }
    expect(
      await ManagedProjectOwnership.find({
        channelType: "feishu",
        accountId: host.accountId,
        externalProjectId: "old",
      }),
    ).toMatchObject({ remoteState: "archived" })
  } finally {
    server.stop(true)
  }
})

test("Feishu failed, invalid, repeated and aborted discovery preserves existing groups", async () => {
  for (const mode of ["error", "invalid", "repeat", "abort"]) {
    const host = ChannelHost.create({ channelType: "feishu", accountId: crypto.randomUUID() })
    await host.projects.ensure({ externalProjectId: "old", name: "Old", isActive: true })
    const abort = new AbortController()
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (!new URL(request.url).searchParams.has("page_token"))
          return Response.json({ code: 0, data: { items: [], has_more: true, page_token: "next" } })
        if (mode === "abort") abort.abort()
        return Response.json(
          mode === "error"
            ? { code: 99991672 }
            : { code: 0, data: { items: [], has_more: true, page_token: mode === "invalid" ? "" : "next" } },
        )
      },
    })
    try {
      await expect(
        refreshFeishuProjects({
          apiBase: server.url.href.replace(/\/$/, ""),
          getAccessToken: async () => "fixture",
          signal: abort.signal,
          host,
        }),
      ).rejects.toBeDefined()
      expect(
        await ManagedProjectOwnership.find({
          channelType: "feishu",
          accountId: host.accountId,
          externalProjectId: "old",
        }),
      ).toMatchObject({ remoteState: "active" })
    } finally {
      server.stop(true)
    }
  }
})
