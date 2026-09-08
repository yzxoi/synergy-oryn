import { Lock } from "../util/lock"
import { Log } from "../util/log"
import { externalIdentityHash } from "../util/identity"
import { OrynLabel, type LabelTarget, type Case, type Attempt, type Assignment } from "./schema"
import { OrynConfig } from "./config"
import { OrynStore, storeError } from "./store"
import { caseMarker, orynBranch } from "./publish"

export type LabelSnapshot = { labels: string[]; owned: boolean }
export type LabelRead = LabelTarget & { marker: string; branch: string }
export type LabelTransport = {
  observe(input: LabelRead): Promise<LabelSnapshot>
  apply(input: LabelRead & { add: OrynLabel[]; remove: OrynLabel[]; beforeWrite: () => Promise<void> }): Promise<void>
}
let transport: LabelTransport | undefined
export function setLabelTransport(value: LabelTransport | undefined) {
  transport = value
}
const log = Log.create({ service: "oryn.labels" })
let nextCase = 0

export namespace OrynLabels {
  export function project(
    record: Case,
    attempt: Attempt | undefined,
    assignments: Assignment[],
    priority?: "p0" | "p1" | "p2" | "p3",
  ): OrynLabel[] {
    const current = assignments.filter((item) => item.attemptId === attempt?.id && item.epoch === record.epoch)
    const pending = current.filter((item) => !item.acceptedReportId)
    let stage: "triage" | "reproducing" | "coding" | "verifying" | "reviewing" | "needs-human" | "ready" = "triage"
    if (record.control !== "active" || attempt?.disposition === "handed_off" || attempt?.disposition === "failed")
      stage = "needs-human"
    else if (attempt?.disposition === "ready") stage = "ready"
    else if (pending.some((item) => item.stage === "verify")) stage = "verifying"
    else if (pending.some((item) => item.stage === "review")) stage = "reviewing"
    else if (attempt?.candidateSha) stage = "verifying"
    else if (pending.some((item) => item.stage === "code")) stage = "coding"
    else if (current.some((item) => item.stage === "repro")) stage = "reproducing"
    return [`oryn:type/${record.kind}`, `oryn:status/${stage}`, `oryn:priority/${priority ?? "untriaged"}`]
  }

  export function delta(current: string[], wanted: OrynLabel[]): { add: OrynLabel[]; remove: OrynLabel[] } {
    const existing = new Set(current)
    const priorityPresent = current.some((label) => label.startsWith("oryn:priority/"))
    return {
      add: wanted.filter((label) => !existing.has(label) && !(priorityPresent && label.startsWith("oryn:priority/"))),
      remove: current.filter(
        (label): label is OrynLabel =>
          OrynLabel.safeParse(label).success &&
          !label.startsWith("oryn:priority/") &&
          !wanted.includes(label as OrynLabel),
      ),
    }
  }

  async function inputs(caseId: string) {
    const config = await OrynConfig.info()
    const record = await OrynStore.getCase(caseId)
    const repo = record && config?.repositories?.[record.repoAlias]
    if (!config?.enabled || !record || record.control !== "active" || !repo?.labels) return
    const attempt = record.activeAttemptId ? await OrynStore.getAttempt(record.id, record.activeAttemptId) : undefined
    const labels = project(record, attempt, await OrynStore.listAssignments(record.id), repo.defaultPriority)
    const targets: LabelTarget[] = [
      ...(record.issueNumber ? [{ kind: "issue" as const, number: record.issueNumber }] : []),
      ...record.pullNumbers.map((number) => ({ kind: "pull" as const, number })),
    ].map((target) => ({
      ...target,
      labels,
      repository: `${repo.owner}/${repo.repo}`,
      baseBranch: repo.baseBranch ?? "dev",
      ...(target.kind === "pull" ? { candidateSha: attempt?.candidateSha } : {}),
    }))
    return { record, targets }
  }

  export async function syncCase(caseId: string): Promise<void> {
    if (!transport) return
    const activeTransport = transport
    using lock = await Lock.tryAcquireWrite(`oryn-labels:${caseId}`)
    if (!lock) return
    const state = await inputs(caseId)
    if (!state) return
    const { record } = state
    for (const target of state.targets) {
      if (target.kind === "pull" && !target.candidateSha) continue
      const serialized = JSON.stringify(target)
      const valid = async () => {
        const fresh = await inputs(caseId)
        return fresh?.record.epoch === record.epoch && fresh.targets.some((item) => JSON.stringify(item) === serialized)
      }
      const read = { ...target, marker: caseMarker(caseId), branch: orynBranch(caseId) }
      const snapshot = await activeTransport.observe(read)
      if (!snapshot.owned || !(await valid())) continue
      const changes = delta(snapshot.labels, target.labels)
      const actions = (await OrynStore.listActions({ caseId }))
        .filter(
          (action) =>
            action.operation === "sync_labels" &&
            action.labelTarget?.number === target.number &&
            action.labelTarget.kind === target.kind,
        )
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      const digest = externalIdentityHash(serialized)
      let action = actions.findLast(
        (item) =>
          item.epoch === record.epoch &&
          item.payloadDigest === digest &&
          !["cancelled", "rejected"].includes(item.state),
      )
      for (const old of actions) {
        if (old.id === action?.id || !["prepared", "in_flight", "ambiguous"].includes(old.state)) continue
        await OrynStore.mutateAction(old.id, (item) => ({ ...item, state: "cancelled" }))
      }
      if (!changes.add.length && !changes.remove.length) {
        if (action && action.state !== "acknowledged")
          await OrynStore.mutateAction(action.id, (item) => ({ ...item, state: "acknowledged" }))
        continue
      }
      if (action && action.attempts >= 3 && action.state !== "acknowledged") continue
      if (!action || action.state === "acknowledged")
        action = await OrynStore.writeAction({
          caseId,
          operation: "sync_labels",
          payloadDigest: digest,
          expectedHead: target.candidateSha,
          labelTarget: target,
          expectedRevision: record.revision,
          epoch: record.epoch,
          requestKey: `labels:${digest}:${externalIdentityHash(JSON.stringify(snapshot.labels))}`,
          state: "prepared",
          remoteRefs: target.kind === "pull" ? { pullNumber: target.number } : { issueNumber: target.number },
        })
      if (!(await valid())) {
        await OrynStore.mutateAction(action.id, (item) => ({ ...item, state: "cancelled" }))
        continue
      }
      await OrynStore.mutateAction(action.id, (item) => ({ ...item, state: "in_flight", attempts: item.attempts + 1 }))
      try {
        await activeTransport.apply({
          ...read,
          ...changes,
          beforeWrite: async () => {
            if (!(await valid())) throw storeError("HUMAN_OWNED", "label projection changed before write")
          },
        })
        const after = await activeTransport.observe(read)
        const remaining = delta(after.labels, target.labels)
        if (!after.owned || remaining.add.length || remaining.remove.length)
          throw storeError("REMOTE_AMBIGUOUS", "label projection is not confirmed")
        await OrynStore.mutateAction(action.id, (item) => ({ ...item, state: "acknowledged" }))
      } catch (error) {
        await OrynStore.mutateAction(action.id, (item) => ({
          ...item,
          state: "ambiguous",
          lastErrorClass: error instanceof Error ? error.name : "unknown",
        }))
      }
    }
  }

  export async function syncAll(): Promise<void> {
    if (!transport || !(await OrynConfig.enabled())) return
    using lock = await Lock.tryAcquireWrite("oryn-label-poll")
    if (!lock) return
    const cases = await OrynStore.listCases({ control: "active" })
    if (!cases.length) {
      nextCase = 0
      return
    }
    const start = nextCase % cases.length
    const count = Math.min(cases.length, 20)
    nextCase = (start + count) % cases.length
    for (let index = 0; index < count; index++) {
      const record = cases[(start + index) % cases.length]!
      await syncCase(record.id).catch((error) =>
        log.warn("label synchronization failed", { errorClass: error instanceof Error ? error.name : "unknown" }),
      )
    }
  }
}
