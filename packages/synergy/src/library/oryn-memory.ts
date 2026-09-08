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
  async promote(input: Content & { id: string }, commit: (write: () => string) => Promise<string>) {
    using _lock = await Lock.write(`oryn-library-memory:${input.id}`)
    const embedding = existing(input.id, input)
      ? undefined
      : await Embedding.generateInstallation({ id: input.id, text: `${input.title}\n${input.content}` })
    return await commit(() => {
      if (!existing(input.id, input)) {
        if (!embedding) throw new Error("Oryn memory disappeared before commit; retry is required")
        LibraryDB.Memory.insert({ ...input, category: "knowledge", recallMode: "contextual" }, embedding)
      }
      return input.id
    })
  },
  async remove(id: string, expected: Content) {
    using _lock = await Lock.write(`oryn-library-memory:${id}`)
    if (existing(id, expected)) LibraryDB.Memory.remove(id)
  },
}
