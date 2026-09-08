import { expect, test } from "bun:test"
import { LibraryDB } from "../../src/library/database"
import { OrynMemory } from "../../src/library/oryn-memory"
import { globalConfig } from "../oryn/fixture"
import { scriptedModel } from "../oryn/fixtures/model"
import { tmpdir } from "../fixture/fixture"
import { Scope } from "../../src/scope"
import { Embedding } from "../../src/vector/embedding"
import { Config } from "../../src/config/config"
import { ScopeContext } from "../../src/scope/context"

const commit = async (write: () => string) => write()

test("Library withdrawal waits for a pending Host commit before removing the row", async () => {
  const input = { id: `mem_oryn_${crypto.randomUUID()}`, title: "Pending replay", content: "Same identity" }
  LibraryDB.Memory.insert(
    { ...input, category: "knowledge", recallMode: "contextual" },
    { id: input.id, model: "fixture", vector: [1, 0, 0, 0, 0, 0, 0, 0] },
  )
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const promotion = OrynMemory.promote(input, async (write) => {
    entered.resolve()
    await release.promise
    return write()
  })
  const settled = promotion.then(
    (id) => ({ id }),
    (error: unknown) => ({ error }),
  )
  try {
    await entered.promise
    const removal = OrynMemory.remove(input.id, input)
    release.resolve()
    expect(await settled).toEqual({ id: input.id })
    await removal
    expect(LibraryDB.Memory.get(input.id)).toBeNull()
  } finally {
    release.resolve()
    await settled
    LibraryDB.Memory.remove(input.id)
  }
})

test("fresh Oryn promotion embeds once and concurrent replay keeps one Library row", async () => {
  await using model = scriptedModel(() => {
    throw new Error("chat is not used by memory promotion")
  })
  await using config = await globalConfig({
    embedding: { apiKey: "fixture-only", model: "fixture-embedding", baseURL: model.config.api },
  })
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  const input = { id: `mem_oryn_${crypto.randomUUID()}`, title: "A new lesson", content: "A scoped observation" }
  await ScopeContext.provide({
    scope,
    fn: async () => {
      try {
        expect(await Promise.all([OrynMemory.promote(input, commit), OrynMemory.promote(input, commit)])).toEqual([
          input.id,
          input.id,
        ])
        expect(model.embeddings).toHaveLength(1)
        expect(model.errors).toEqual([])
        expect(LibraryDB.Memory.get(input.id)).toMatchObject({
          ...input,
          category: "knowledge",
          recall_mode: "contextual",
        })
        await OrynMemory.remove(input.id, input)
        expect(LibraryDB.Memory.get(input.id)).toBeNull()
      } finally {
        LibraryDB.Memory.remove(input.id)
      }
    },
  })
})

test("Oryn reuses an acknowledged Library row without an embedding request and removes only its content", async () => {
  const input = {
    id: `mem_oryn_${crypto.randomUUID()}`,
    title: "A verified lesson",
    content: "Evidence and invalidation",
  }
  LibraryDB.Memory.insert(
    { ...input, category: "knowledge", recallMode: "contextual" },
    { id: input.id, model: "fixture", vector: [1, 0, 0, 0, 0, 0, 0, 0] },
  )
  try {
    const original = LibraryDB.Memory.get(input.id)
    expect(await OrynMemory.promote(input, commit)).toBe(input.id)
    expect(LibraryDB.Memory.get(input.id)).toEqual(original)
    await expect(OrynMemory.promote({ ...input, content: "unrelated replacement" }, commit)).rejects.toThrow(
      "different content",
    )
    await expect(OrynMemory.remove(input.id, { ...input, title: "unrelated title" })).rejects.toThrow(
      "different content",
    )
    expect(LibraryDB.Memory.get(input.id)).toEqual(original)
    await OrynMemory.remove(input.id, input)
    await OrynMemory.remove(input.id, input)
    expect(LibraryDB.Memory.get(input.id)).toBeNull()
  } finally {
    LibraryDB.Memory.remove(input.id)
  }
})

test("Library preparation cannot insert when the Host refuses commit", async () => {
  await using model = scriptedModel(() => {
    throw new Error("chat is not used")
  })
  await using config = await globalConfig({
    embedding: { apiKey: "fixture-only", model: "fixture-embedding", baseURL: model.config.api },
  })
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  const input = { id: `mem_oryn_${crypto.randomUUID()}`, title: "Pending lesson", content: "Not delivered" }
  await ScopeContext.provide({
    scope,
    fn: async () => {
      try {
        await expect(
          OrynMemory.promote(input, async () => {
            throw new Error("delivery revoked")
          }),
        ).rejects.toThrow("delivery revoked")
        expect(model.embeddings).toHaveLength(1)
        expect(LibraryDB.Memory.get(input.id)).toBeNull()
        expect(await OrynMemory.promote(input, commit)).toBe(input.id)
        expect(LibraryDB.Memory.get(input.id)?.content).toBe(input.content)
      } finally {
        LibraryDB.Memory.remove(input.id)
      }
    },
  })
})

test.each(["absent", "candidate"] as const)(
  "Oryn embedding uses installation configuration with %s Scope",
  async (context) => {
    await using host = scriptedModel(() => {
      throw new Error("chat is not used")
    })
    await using candidate = scriptedModel(() => {
      throw new Error("chat is not used")
    })
    await using global = await globalConfig({
      embedding: { apiKey: "host-fixture", model: "host-embedding", baseURL: host.config.api },
    })
    await using tmp = await tmpdir({
      git: true,
      config: {
        embedding: { apiKey: "candidate-fixture", model: "candidate-embedding", baseURL: candidate.config.api },
      },
    })
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    const input = {
      id: `mem_oryn_${crypto.randomUUID()}`,
      title: "Host lesson",
      content: "Installation-owned embedding",
    }
    const promote = async () => {
      if (context === "candidate") expect((await Config.current()).embedding?.baseURL).toBe(candidate.config.api)
      expect(await OrynMemory.promote(input, commit)).toBe(input.id)
    }
    try {
      if (context === "candidate") await ScopeContext.provide({ scope, fn: promote })
      else {
        expect(ScopeContext.tryScope()).toBeUndefined()
        await promote()
      }
      expect(host.embeddings).toHaveLength(1)
      expect(candidate.embeddings).toEqual([])
      expect(LibraryDB.Memory.get(input.id)?.content).toBe(input.content)
    } finally {
      LibraryDB.Memory.remove(input.id)
    }
  },
)

test("Oryn local embedding does not reuse a candidate's initialized extractor", async () => {
  await using global = await globalConfig({
    embedding: { local: { source: "custom", remoteHost: "https://host-models.example" } },
  })
  await using tmp = await tmpdir({
    git: true,
    config: { embedding: { local: { source: "custom", remoteHost: "https://candidate-models.example" } } },
  })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  const observed: string[] = []
  const disposed: string[] = []
  let selected = ""
  await Embedding.dispose()
  Embedding.setLocalRuntimeControlsForTest({
    async loadRuntime() {
      return {
        configure({ remoteHost }) {
          selected = remoteHost
        },
        async isCached() {
          return true
        },
        async pipeline() {
          const origin = selected
          return Object.assign(
            async () => {
              observed.push(origin)
              return { data: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]) }
            },
            {
              async dispose() {
                disposed.push(origin)
              },
            },
          )
        },
      }
    },
  })
  const input = { id: `mem_oryn_${crypto.randomUUID()}`, title: "Local lesson", content: "Host local model" }
  const recovered = { ...input, id: `mem_oryn_${crypto.randomUUID()}` }
  try {
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await Embedding.generate({ id: "candidate-query", text: "candidate" })
        await OrynMemory.promote(input, commit)
      },
    })
    expect(ScopeContext.tryScope()).toBeUndefined()
    await OrynMemory.promote(recovered, commit)
    await ScopeContext.provide({ scope, fn: () => Embedding.generate({ id: "candidate-again", text: "candidate" }) })
    expect(observed).toEqual([
      "https://candidate-models.example/",
      "https://host-models.example/",
      "https://host-models.example/",
      "https://candidate-models.example/",
    ])
    await Embedding.dispose()
    expect(disposed.sort()).toEqual(["https://candidate-models.example/", "https://host-models.example/"])
  } finally {
    await Embedding.resetForTest()
    LibraryDB.Memory.remove(input.id)
    LibraryDB.Memory.remove(recovered.id)
  }
})
