import { Log } from "../util/log"
import { Storage } from "../storage/storage"
import { OrynPath } from "./path"
import type { Migration } from "../migration"
import { MigrationRegistry } from "../migration/registry"

const log = Log.create({ service: "oryn.migration" })

export const migrations: Migration[] = [
  {
    id: "20260907-oryn-baseline",
    description: "Create the Oryn record namespace root so fresh installs and upgrades share one layout",
    version: "1.0.0",
    domain: "oryn",
    async up() {
      await Storage.write(OrynPath.orynRoot(), { schemaVersion: 1 }).catch(() => undefined)
      log.info("oryn baseline migration complete")
    },
  },
]
MigrationRegistry.register("oryn", migrations)
