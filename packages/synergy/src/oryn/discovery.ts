import { z } from "zod"
import { Storage } from "../storage/storage"
import { Lock } from "../util/lock"
import { externalIdentityHash } from "../util/identity"
import { OrynPath } from "./path"
import { OrynConfig } from "./config"
import { OrynStore, storeError } from "./store"

export const DiscoveryInput = z
  .object({
    caseId: z.string().min(1),
    relation: z.enum(["current_change", "independent", "blocker", "environment", "security"]),
    summary: z.string().min(1).max(1000),
    observed: z.string().min(1).max(4000),
    expected: z.string().min(1).max(4000),
    evidenceRefs: z.array(z.string().min(1)).max(32),
    path: z.string().max(500).optional(),
  })
  .strict()
const Discovery = DiscoveryInput.omit({ caseId: true })
  .extend({
    schemaVersion: z.literal(1),
    id: z.string(),
    parentCaseId: z.string(),
    rootCaseId: z.string(),
    repoAlias: z.string(),
    depth: z.number().int(),
    sourceSessionId: z.string(),
    sourceAttemptId: z.string().optional(),
    sourceSha: z.string().optional(),
    childCaseId: z.string().optional(),
    state: z.enum(["recorded", "queued", "needs_human"]),
    createdAt: z.number(),
  })
  .strict()
export type Discovery = z.infer<typeof Discovery>

export namespace OrynDiscovery {
  export async function list() {
    const ids = await Storage.scan(OrynPath.discoveriesRoot())
    return Promise.all(ids.map(async (id) => Discovery.parse(await Storage.read(OrynPath.discovery(id)))))
  }
  export async function lineage(caseId: string) {
    return (await list()).find((item) => item.childCaseId === caseId)
  }
  export async function propose(callerSessionID: string, raw: z.infer<typeof DiscoveryInput>) {
    const input = DiscoveryInput.parse(raw)
    const record = await OrynStore.getCaseForSession(input.caseId, callerSessionID)
    const config = await OrynConfig.info()
    if (!config?.enabled || record.control !== "active")
      throw storeError("NOT_AUTHORIZED", "Discovery requires active Oryn work")
    const binding = await OrynStore.sessionSourceBinding(callerSessionID)
    const assignment =
      binding?.role === "worker"
        ? (await OrynStore.listAssignments(record.id)).find(
            (item) =>
              item.sessionId === callerSessionID &&
              item.attemptId === record.activeAttemptId &&
              item.epoch === record.epoch,
          )
        : undefined
    if (binding?.role === "worker" && !assignment) throw storeError("NOT_AUTHORIZED", "Discovery worker is stale")
    const attempt = record.activeAttemptId ? await OrynStore.getAttempt(record.id, record.activeAttemptId) : undefined
    for (const id of input.evidenceRefs) {
      const receipt = await OrynStore.getRun(record.id, id)
      const report = (await OrynStore.getReview(record.id, id)) ?? (await OrynStore.getWorkerReport(record.id, id))
      if (!receipt && !report)
        throw storeError("EVIDENCE_INSUFFICIENT", "Discovery evidence must reference records from the parent Case")
    }
    using lock = await Lock.write("oryn-discovery-admission")
    const all = await list()
    const parent = all.find((item) => item.childCaseId === record.id)
    const rootCaseId = parent?.rootCaseId ?? record.id
    const depth = (parent?.depth ?? 0) + 1
    const id = externalIdentityHash(
      record.repoAlias,
      input.relation,
      input.path ?? "",
      input.observed.trim(),
      input.expected.trim(),
    )
    const prior = all.find((item) => item.id === id)
    if (prior) return prior
    const { caseId, ...details } = input
    let discovery: Discovery = {
      ...details,
      schemaVersion: 1,
      id,
      parentCaseId: caseId,
      rootCaseId,
      repoAlias: record.repoAlias,
      depth,
      sourceSessionId: callerSessionID,
      sourceAttemptId: attempt?.id,
      sourceSha:
        !assignment || assignment.stage === "review" || assignment.stage === "verify"
          ? (attempt?.candidateSha ?? attempt?.baselineSha)
          : attempt?.baselineSha,
      state: "recorded",
      createdAt: Date.now(),
    }
    const independent = ["independent", "blocker"].includes(input.relation)
    if (
      input.relation === "security" ||
      depth > (config.limits?.maxDiscoveryDepth ?? 2) ||
      all.filter((item) => item.rootCaseId === rootCaseId).length >= (config.limits?.maxDescendants ?? 8)
    )
      discovery.state = "needs_human"
    if (independent && discovery.state !== "needs_human") {
      const source = await OrynStore.getSource(record.sourceIds[0]!)
      if (!source) throw storeError("NOT_AUTHORIZED", "Discovery source is unavailable")
      const claimed = await OrynStore.claimSource({ identity: source.identity, requestKey: `discovery:${id}` })
      discovery = { ...discovery, childCaseId: claimed.claim.caseId, state: "queued" }
      // Persist lineage before creating runnable work; replay repairs either side.
      await Storage.write(OrynPath.discovery(id), discovery)
      await materialize(discovery)
    }
    await Storage.write(OrynPath.discovery(id), Discovery.parse(discovery))
    return discovery
  }
  async function materialize(discovery: Discovery) {
    if (!discovery.childCaseId) return
    const parent = await OrynStore.getCase(discovery.parentCaseId)
    if (!parent || parent.control !== "active") return
    await OrynStore.createCase({
      caseId: discovery.childCaseId,
      kind: "bug",
      summary: discovery.summary,
      observed: discovery.observed,
      expected: discovery.expected,
      repoAlias: discovery.repoAlias,
      sourceKeyHash: parent.sourceIds[0]!,
    })
    await OrynStore.linkSourceToCase(parent.sourceIds[0]!, discovery.childCaseId)
    await OrynStore.updateClaim(parent.sourceIds[0]!, `discovery:${discovery.id}`, { state: "completed" })
  }
  export async function recover() {
    for (const discovery of await list()) if (discovery.state === "queued") await materialize(discovery)
  }
}
