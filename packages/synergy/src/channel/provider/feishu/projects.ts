import { z } from "zod"
import type { ChannelHost } from "../../host"
import type { FeishuApiContext } from "./api-context"

const Page = z.object({
  code: z.literal(0),
  data: z.object({
    items: z.array(z.object({ chat_id: z.string().min(1), name: z.string() })),
    has_more: z.boolean(),
    page_token: z.string().optional(),
  }),
})

// Feishu group-list contract: https://open.feishu.cn/document/server-docs/group/chat/list
export async function refreshFeishuProjects(
  input: FeishuApiContext & {
    signal: AbortSignal
    host: ChannelHost.Instance
  },
) {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(60_000)])
  signal.throwIfAborted()
  const token = await input.getAccessToken()
  const projects = new Map<string, ChannelHost.ExternalProjectRef>()
  const tokens = new Set<string>()
  let pageToken = ""
  for (let page = 0; page < 100; page++) {
    signal.throwIfAborted()
    const url = new URL(input.apiBase + "/im/v1/chats")
    url.searchParams.set("page_size", "100")
    if (pageToken) url.searchParams.set("page_token", pageToken)
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal, redirect: "error" })
    if (!response.ok) throw new Error(`Feishu group discovery failed (HTTP ${response.status})`)
    const result = Page.safeParse(await response.json())
    if (!result.success) throw new Error("Feishu group discovery failed; check group-list permissions and API response")
    for (const chat of result.data.data.items) {
      projects.set(chat.chat_id, { externalProjectId: chat.chat_id, name: chat.name || chat.chat_id, isActive: true })
    }
    signal.throwIfAborted()
    if (!result.data.data.has_more) {
      await input.host.projects.reconcile({ projects: [...projects.values()], complete: true })
      return
    }
    pageToken = result.data.data.page_token ?? ""
    if (!pageToken || tokens.has(pageToken)) throw new Error("Feishu group discovery returned invalid pagination")
    tokens.add(pageToken)
  }
  throw new Error("Feishu group discovery exceeded its page limit")
}
