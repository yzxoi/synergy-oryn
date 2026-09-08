import { expect, test } from "bun:test"
import { LibraryDB } from "../../src/library/database"
import { OrynMemory } from "../../src/library/oryn-memory"
import { globalConfig } from "../oryn/fixture"
import { scriptedModel } from "../oryn/fixtures/model"
import { tmpdir } from "../fixture/fixture"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"

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
        expect(await Promise.all([OrynMemory.promote(input), OrynMemory.promote(input)])).toEqual([input.id, input.id])
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
    expect(await OrynMemory.promote(input)).toBe(input.id)
    expect(LibraryDB.Memory.get(input.id)).toEqual(original)
    await expect(OrynMemory.promote({ ...input, content: "unrelated replacement" })).rejects.toThrow(
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
