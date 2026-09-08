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

const EmbeddingRequest = z.object({ model: z.string(), input: z.union([z.string(), z.array(z.string())]) })

export function scriptedModel(respond: (request: ModelRequest) => ModelStep | Promise<ModelStep>, maxRequests = 64) {
  const requests: ModelRequest[] = []
  const embeddings: z.infer<typeof EmbeddingRequest>[] = []
  const errors: string[] = []
  const steps: ModelStep[] = []
  let abortedRequests = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      try {
        const endpoint = new URL(request.url).pathname
        if (endpoint === "/v1/embeddings") {
          const body = EmbeddingRequest.parse(await request.json())
          if (embeddings.length >= maxRequests) throw new Error("scripted embedding request budget exhausted")
          embeddings.push(body)
          const inputs = Array.isArray(body.input) ? body.input : [body.input]
          return Response.json({
            object: "list",
            model: body.model,
            data: inputs.map((input, index) => {
              const digest = new Bun.CryptoHasher("sha256").update(input).digest()
              const vector = Array.from({ length: 384 }, (_, i) => digest[i % digest.length] - 127.5)
              const magnitude = Math.hypot(...vector)
              return { object: "embedding", index, embedding: vector.map((value) => value / magnitude) }
            }),
            usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
          })
        }
        if (endpoint !== "/v1/chat/completions") throw new Error("unexpected model endpoint")
        const body = Request.parse(await request.json())
        if (requests.length >= maxRequests) throw new Error("scripted model request budget exhausted")
        requests.push(body)
        const requestId = requests.length
        const step = await respond(body)
        steps.push(step)
        const delta =
          "tool" in step
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${requestId}`,
                    type: "function",
                    function: { name: step.tool, arguments: JSON.stringify(step.input) },
                  },
                ],
              }
            : { role: "assistant", content: step.text }
        const chunks = [
          { id: `fixture_${requestId}`, choices: [{ index: 0, delta, finish_reason: null }] },
          {
            id: `fixture_${requestId}`,
            choices: [{ index: 0, delta: {}, finish_reason: "tool" in step ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
        ]
        return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        })
      } catch (error) {
        if (request.signal.aborted) {
          abortedRequests++
          return new Response(null, { status: 499 })
        }
        errors.push(error instanceof Error ? error.message : String(error))
        return Response.json({ error: { message: errors.at(-1) } }, { status: 400 })
      }
    },
  })
  return {
    requests,
    embeddings,
    errors,
    steps,
    get abortedRequests() {
      return abortedRequests
    },
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
