import { LibraryDB } from "./database"
import { Embedding } from "../vector/embedding"
import { Lock } from "../util/lock"

type Content = { title: string; content: string }

function existing(id: string, expected: Content) {
  const row = LibraryDB.Memory.get(id)
  if (
    row &&
    (row.title !== expected.title ||
      row.content !== expected.content ||
      row.category !== "knowledge" ||
      row.recall_mode !== "contextual")
  ) {
    throw new Error("Oryn memory identity contains different content; manual reconciliation is required")
  }
  return row
}

export const OrynMemory = {
  async promote(input: Content & { id: string }) {
    using _lock = await Lock.write(`oryn-library-memory:${input.id}`)
    if (existing(input.id, input)) return input.id
    const embedding = await Embedding.generate({ id: input.id, text: `${input.title}\n${input.content}` })
    if (!existing(input.id, input)) {
      LibraryDB.Memory.insert({ ...input, category: "knowledge", recallMode: "contextual" }, embedding)
    }
    return input.id
  },
  async remove(id: string, expected: Content) {
    using _lock = await Lock.write(`oryn-library-memory:${id}`)
    if (existing(id, expected)) LibraryDB.Memory.remove(id)
  },
}
