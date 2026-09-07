import { Log } from "../util/log"
import { Storage } from "../storage/storage"
import { OrynPath } from "./path"
import type { Migration } from "../migration"
import { MigrationRegistry } from "../migration/registry"
import { z } from "zod"
import { OutboxEntry } from "./schema"

const log = Log.create({ service: "oryn.migration" })

const LegacyOutboxEntry = OutboxEntry.extend({
  schemaVersion: z.literal(1),
  state: z.enum(["pending", "delivered", "suppressed"]),
}).omit({ attemptedAt: true })

export const migrations: Migration[] = [
  {
    id: "20260907-oryn-baseline",
    description: "Create the Oryn record namespace root so fresh installs and upgrades share one layout",
    version: "1.0.0",
    domain: "oryn",
    async up() {
      await Storage.write(OrynPath.orynRoot(), { schemaVersion: 1 })
      log.info("oryn baseline migration complete")
    },
  },
  {
    id: "20260908-oryn-outbox-dispatch",
    description: "Distinguish unsent notifications from uncertain legacy dispatches",
    version: "1.0.0",
    domain: "oryn",
    dependsOn: ["20260907-oryn-baseline"],
    async up(progress) {
      const ids = await Storage.scan(OrynPath.outboxRoot())
      for (const [index, id] of ids.entries()) {
        const value = await Storage.read<unknown>(OrynPath.outbox(id))
        if (!OutboxEntry.safeParse(value).success) {
          const legacy = LegacyOutboxEntry.parse(value)
          await Storage.write(
            OrynPath.outbox(id),
            OutboxEntry.parse({
              ...legacy,
              schemaVersion: 2,
              state: legacy.state === "pending" ? "ambiguous" : legacy.state,
            }),
          )
        }
        progress(index + 1, ids.length)
      }
    },
  },
]
MigrationRegistry.register("oryn", migrations)
