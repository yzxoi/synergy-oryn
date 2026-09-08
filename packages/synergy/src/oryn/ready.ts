import { externalIdentityHash } from "../util/identity"
import { OrynConfig } from "./config"
import { OrynStore } from "./store"
import type { ActionReceipt } from "./schema"

export namespace OrynReady {
  export type Projection = NonNullable<Awaited<ReturnType<typeof projection>>>
  let verifier: ((ready: Projection) => Promise<boolean>) | undefined

  export function setVerifier(fn: (ready: Projection) => Promise<boolean>) {
    verifier = fn
  }

  export async function confirm(ready: Projection) {
    return verifier ? await verifier(ready).catch(() => false) : false
  }

  export function matchesConfig(
    target: NonNullable<ActionReceipt["readyTarget"]>,
    repo: { owner: string; repo: string; baseBranch?: string; deliveryCheck?: boolean },
  ) {
    return (
      target.repository === `${repo.owner}/${repo.repo}` &&
      target.baseBranch === (repo.baseBranch ?? "dev") &&
      target.deliveryCheck === (repo.deliveryCheck === true)
    )
  }

  export async function projection(caseId: string) {
    const record = await OrynStore.getCase(caseId)
    if (!record || record.control !== "active" || !record.activeAttemptId) return
    const attempt = await OrynStore.getAttempt(record.id, record.activeAttemptId)
    if (!attempt || attempt.disposition !== "ready" || !attempt.candidateSha) return
    const config = await OrynConfig.info()
    const repo = config?.repositories?.[record.repoAlias]
    if (!config?.enabled || !repo) return
    const action = (await OrynStore.listActions({ caseId }))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .find(
        (action) =>
          action.operation === "mark_ready" &&
          action.state === "acknowledged" &&
          action.epoch === record.epoch &&
          action.expectedRevision === record.revision &&
          action.expectedHead === attempt.candidateSha &&
          action.readyTarget?.attemptId === attempt.id &&
          matchesConfig(action.readyTarget, repo) &&
          action.remoteRefs?.pullNumber &&
          action.remoteRefs.pullNumber === record.pullNumbers.at(-1),
      )
    if (!action) return
    return {
      record,
      attempt,
      action,
      policyDigest: externalIdentityHash(JSON.stringify(config)),
      dedupKey: action.readyTarget?.notificationKey ?? `${record.id}:ready:${attempt.id}`,
      text: action.readyTarget?.notificationKey
        ? `Fix is ready for human review: https://github.com/${action.readyTarget.repository}/pull/${action.remoteRefs!.pullNumber} (candidate ${action.expectedHead})`
        : `Fix is ready for human review (PR #${action.remoteRefs!.pullNumber}, candidate ${action.expectedHead})`,
    }
  }
}
