import { Log } from "../util/log"
import { Storage } from "../storage/storage"
import { OrynPath } from "./path"
import type { Migration } from "../migration"
import { MigrationRegistry } from "../migration/registry"
import { z } from "zod"
import { ActionReceipt, AttemptTransition, Case, OutboxEntry } from "./schema"

const log = Log.create({ service: "oryn.migration" })

const LegacyCase = Case.extend({ schemaVersion: z.literal(1) }).omit({ handoff: true })

const LegacyOutboxEntry = OutboxEntry.extend({
  schemaVersion: z.literal(1),
  state: z.enum(["pending", "delivered", "suppressed"]),
}).omit({ attemptedAt: true })

const ActionReceiptV3 = ActionReceipt.extend({
  schemaVersion: z.literal(3),
  readyTarget: ActionReceipt.shape.readyTarget.unwrap().omit({ notificationKey: true }).optional(),
})
const ActionReceiptV2 = ActionReceiptV3.extend({
  schemaVersion: z.literal(2),
  operation: z.enum(["ensure_issue", "ensure_draft", "refresh_pr", "publish_review", "mark_ready", "notify_feishu"]),
}).omit({ labelTarget: true })
const LegacyActionReceipt = ActionReceiptV2.extend({ schemaVersion: z.literal(1) }).omit({ readyTarget: true })

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
  {
    id: "20260908-oryn-ready-target",
    description: "Version publication receipts without inventing targets for legacy readiness actions",
    version: "1.0.0",
    domain: "oryn",
    dependsOn: ["20260908-oryn-outbox-dispatch"],
    async up(progress) {
      const ids = await Storage.scan(OrynPath.actionsRoot())
      for (const [index, id] of ids.entries()) {
        const value = await Storage.read<unknown>(OrynPath.action(id))
        if (
          !ActionReceipt.safeParse(value).success &&
          !ActionReceiptV3.safeParse(value).success &&
          !ActionReceiptV2.safeParse(value).success
        ) {
          const legacy = LegacyActionReceipt.parse(value)
          await Storage.write(OrynPath.action(id), ActionReceiptV2.parse({ ...legacy, schemaVersion: 2 }))
        }
        progress(index + 1, ids.length)
      }
    },
  },
  {
    id: "20260908-oryn-label-target",
    description: "Pin label synchronization targets in the external action ledger",
    version: "1.0.0",
    domain: "oryn",
    dependsOn: ["20260908-oryn-ready-target"],
    async up(progress) {
      const ids = await Storage.scan(OrynPath.actionsRoot())
      for (const [index, id] of ids.entries()) {
        const value = await Storage.read<unknown>(OrynPath.action(id))
        if (!ActionReceipt.safeParse(value).success && !ActionReceiptV3.safeParse(value).success) {
          const legacy = ActionReceiptV2.parse(value)
          await Storage.write(OrynPath.action(id), ActionReceiptV3.parse({ ...legacy, schemaVersion: 3 }))
        }
        progress(index + 1, ids.length)
      }
    },
  },
  {
    id: "20260908-oryn-ready-notification",
    description: "Version readiness notifications while preserving legacy publication identity",
    version: "1.0.0",
    domain: "oryn",
    dependsOn: ["20260908-oryn-label-target"],
    async up(progress) {
      const ids = await Storage.scan(OrynPath.actionsRoot())
      for (const [index, id] of ids.entries()) {
        const value = await Storage.read<unknown>(OrynPath.action(id))
        if (!ActionReceipt.safeParse(value).success) {
          const legacy = ActionReceiptV3.parse(value)
          await Storage.write(OrynPath.action(id), ActionReceipt.parse({ ...legacy, schemaVersion: 4 }))
        }
        progress(index + 1, ids.length)
      }
    },
  },
  {
    id: "20260908-oryn-handoff-outcome",
    description: "Version Cases to preserve explicit human-handoff outcomes without inventing legacy reasons",
    version: "1.0.0",
    domain: "oryn",
    dependsOn: ["20260907-oryn-baseline"],
    async up(progress) {
      const ids = await Storage.scan(OrynPath.casesRoot())
      for (const [index, id] of ids.entries()) {
        const value = await Storage.read<unknown>(OrynPath.caseInfo(id))
        if (!Case.safeParse(value).success) {
          const legacy = LegacyCase.parse(value)
          await Storage.write(OrynPath.caseInfo(id), Case.parse({ ...legacy, schemaVersion: 2 }))
        }
        progress(index + 1, ids.length)
      }
    },
  },
  {
    id: "20260908-oryn-attempt-transition-purpose",
    description: "Version Attempt transitions with their control purpose and expected ownership state",
    version: "1.0.0",
    domain: "oryn",
    dependsOn: ["20260907-oryn-baseline"],
    async up(progress) {
      const legacySchema = AttemptTransition.omit({ kind: true, expectedControl: true }).extend({
        schemaVersion: z.literal(1),
      })
      const cases = await Storage.scan(OrynPath.casesRoot())
      for (const [index, caseId] of cases.entries()) {
        for (const id of await Storage.scan(OrynPath.attemptTransitionsRoot(caseId))) {
          const key = OrynPath.attemptTransition(caseId, id)
          const raw = await Storage.read<unknown>(key)
          if (!AttemptTransition.safeParse(raw).success) {
            const legacy = legacySchema.parse(raw)
            await Storage.write(
              key,
              AttemptTransition.parse({ ...legacy, schemaVersion: 2, kind: "rework", expectedControl: "active" }),
            )
          }
        }
        progress(index + 1, cases.length)
      }
    },
  },
]
MigrationRegistry.register("oryn", migrations)
