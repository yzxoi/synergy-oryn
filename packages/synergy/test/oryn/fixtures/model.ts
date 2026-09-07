import { z } from "zod"

const Request = z.object({
  model: z.string(),
  messages: z.array(
    z.object({ role: z.string(), content: z.unknown().optional(), tool_call_id: z.string().optional() }).passthrough(),
  ),
  tools: z.array(z.object({ function: z.object({ name: z.string() }).passthrough() }).passthrough()).optional(),
})
export type ModelRequest = z.infer<typeof Request>
export type ModelStep = { text: string } | { tool: string; input: Record<string, unknown> }

export function scriptedModel(respond: (request: ModelRequest) => ModelStep, maxRequests = 64) {
  const requests: ModelRequest[] = []
  const errors: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      try {
        if (new URL(request.url).pathname !== "/v1/chat/completions") throw new Error("unexpected model endpoint")
        if (requests.length >= maxRequests) throw new Error("scripted model request budget exhausted")
        const body = Request.parse(await request.json())
        requests.push(body)
        const step = respond(body)
        const delta =
          "tool" in step
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${requests.length}`,
                    type: "function",
                    function: { name: step.tool, arguments: JSON.stringify(step.input) },
                  },
                ],
              }
            : { role: "assistant", content: step.text }
        const chunks = [
          { id: `fixture_${requests.length}`, choices: [{ index: 0, delta, finish_reason: null }] },
          {
            id: `fixture_${requests.length}`,
            choices: [{ index: 0, delta: {}, finish_reason: "tool" in step ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
        ]
        return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        })
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
        return Response.json({ error: { message: errors.at(-1) } }, { status: 400 })
      }
    },
  })
  return {
    requests,
    errors,
    config: {
      name: "Oryn scripted model",
      npm: "@ai-sdk/openai-compatible",
      api: `http://127.0.0.1:${server.port}/v1`,
      models: { qa: { name: "Scripted QA", tool_call: true, limit: { context: 128000, output: 4096 } } },
      options: { apiKey: "fixture-only" },
    },
    async [Symbol.asyncDispose]() {
      await server.stop(true)
    },
  }
}
