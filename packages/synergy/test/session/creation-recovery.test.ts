import { expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { tmpdir } from "../fixture/fixture"

test("creation recovery preserves canonical content and is repeatable", async () => {
  await using tmp = await tmpdir({ git: true })
  const scope = await tmp.scope()
  await ScopeContext.provide({
    scope,
    fn: async () => {
      const session = await Session.create({ title: "Preserve my content" })
      const key = StoragePath.sessionIndex(Identifier.asSessionID(session.id))
      await Storage.remove(key)
      try {
        expect((await Session.recoverCreation(scope, session.id))?.title).toBe(session.title)
        expect((await Session.recoverCreation(scope, session.id))?.time.created).toBe(session.time.created)
        expect((await Session.get(session.id)).scope.id).toBe(scope.id)
      } finally {
        await Session.remove(session.id)
      }
    },
  })
})

test("creation recovery cannot replace an index belonging to another scope", async () => {
  await using tmp = await tmpdir({ git: true })
  await using other = await tmpdir({ git: true })
  const scope = await tmp.scope()
  const otherScope = await other.scope()
  await ScopeContext.provide({
    scope,
    fn: async () => {
      const session = await Session.create()
      const key = StoragePath.sessionIndex(Identifier.asSessionID(session.id))
      const original = Session.toIndex(session)
      const foreign = { ...original, scopeID: otherScope.id, directory: otherScope.directory }
      await Storage.write(key, foreign)
      try {
        await expect(Session.recoverCreation(scope, session.id)).rejects.toThrow("identity mismatch")
        expect(await Storage.read<typeof foreign>(key)).toEqual(foreign)
      } finally {
        await Storage.write(key, original)
        await Session.remove(session.id)
      }
    },
  })
})
