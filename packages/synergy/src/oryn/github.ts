import { Config } from "../config/config"
import { ChannelGithub } from "../config/schema"
import { OrynGithubOwned } from "./github-owned"
import { Lock } from "../util/lock"
import { OrynConfig } from "./config"
import { OrynStore, sourceKey } from "./store"
import { OrynGithubStore, GithubSnapshot, type GithubWork } from "./github-store"

type PermissionReader = (repository: string, login: string) => Promise<boolean>
let permissionReader: PermissionReader | undefined
export function setGithubPermissionReader(reader: PermissionReader | undefined) {
  permissionReader = reader
}

export namespace OrynGithub {
  export async function authorized(work: GithubWork, action: "run" | "code" | "review") {
    const bound = await binding(work.accountId, work.repository)
    if (!bound || work.state === "stopped" || work.snapshot.state !== "open" || work.snapshot.draft) return false
    if (work.parentReviewCaseId) {
      const parent = await OrynGithubStore.get(work.parentReviewCaseId)
      if (!parent || parent.state === "stopped" || parent.fingerprint !== work.fingerprint) return false
    }
    if (
      action === "review" &&
      bound.config.allowedOperations &&
      !bound.config.allowedOperations.includes("publish_review")
    )
      return false
    if (work.mode === "review" && bound.config.github?.autoReview === false && !work.authorizedBy) return false
    if (work.authorizedBy && !(await permissionReader?.(work.repository, work.authorizedBy).catch(() => false)))
      return false
    if (action === "code" && !bound.config.github?.autoFix && !work.authorizedBy) return false
    return true
  }

  export type PageTransport = {
    current?(repository: string, number: number, signal?: AbortSignal): Promise<GithubSnapshot>
    page(input: {
      repository: string
      page: number
      since: string
      state?: "open" | "all"
      signal?: AbortSignal
    }): Promise<{ items: GithubSnapshot[]; nextPage?: number }>
  }

  export async function binding(accountId: string, repository: string) {
    const global = await Config.globalRaw()
    const config = global.oryn
    if (!config?.enabled) return
    const account = ChannelGithub.parse(global.channel?.github ?? { type: "github", accounts: {} }).accounts[accountId]
    if (!account || !account.enabled || !account.repositories.includes(repository)) return
    const entry = Object.entries(config.repositories ?? {}).find(
      ([, repo]) =>
        repo.github?.enabled && repo.githubAccount === accountId && `${repo.owner}/${repo.repo}` === repository,
    )
    return entry && { alias: entry[0], config: entry[1] }
  }

  // One bounded page per poll, with durable admission before advancing its cursor.
  // Periodic overlapping reconciliation also covers objects moving between pages.
  export async function scan(input: {
    accountId: string
    repository: string
    transport: PageTransport
    signal?: AbortSignal
  }) {
    const bound = await binding(input.accountId, input.repository)
    if (!bound) return false
    using lock = await Lock.write(`oryn-github-scan:${input.accountId}:${input.repository}`)
    const now = new Date().toISOString()
    const backfillEnabled = bound.config.github?.backfill !== false
    let cursor = (await OrynGithubStore.cursor(input.accountId, input.repository)) ?? {
      schemaVersion: 1 as const,
      page: 1,
      since: now,
      startedAt: now,
      initialized: !backfillEnabled,
      refreshOffset: 0,
      backfillPage: 1,
      backfillEnabled,
      reconcileAt: Date.now(),
    }
    if (backfillEnabled && (!cursor.backfillEnabled || Date.now() - cursor.reconcileAt >= 24 * 60 * 60 * 1000))
      cursor = { ...cursor, initialized: false, backfillPage: 1, reconcileAt: Date.now() }
    cursor.backfillEnabled = backfillEnabled
    // Persist the initial window too: a crash on a fresh installation must not
    // replace its lower bound with a later timestamp and lose partial admission.
    await OrynGithubStore.checkpoint(input.accountId, input.repository, cursor)
    const admit = async (items: GithubSnapshot[]) => {
      for (const raw of items) {
        input.signal?.throwIfAborted()
        await accept({ ...input, repoAlias: bound.alias, snapshot: GithubSnapshot.parse(raw) })
      }
    }
    const delta = await input.transport.page({
      repository: input.repository,
      page: cursor.page,
      since: cursor.since,
      state: "all",
      signal: input.signal,
    })
    await admit(delta.items)
    cursor = delta.nextPage
      ? { ...cursor, page: delta.nextPage }
      : {
          ...cursor,
          page: 1,
          startedAt: now,
          since: new Date(Math.max(0, Date.parse(cursor.startedAt) - 10 * 60 * 1000)).toISOString(),
        }
    await OrynGithubStore.checkpoint(input.accountId, input.repository, cursor)
    if (backfillEnabled && !cursor.initialized) {
      const backlog = await input.transport.page({
        repository: input.repository,
        page: cursor.backfillPage,
        since: new Date(0).toISOString(),
        state: "open",
        signal: input.signal,
      })
      await admit(backlog.items)
      cursor = { ...cursor, backfillPage: backlog.nextPage ?? 1, initialized: !backlog.nextPage }
      await OrynGithubStore.checkpoint(input.accountId, input.repository, cursor)
    }
    if (input.transport.current) {
      const active = await OrynStore.listCases({ repoAlias: bound.alias, control: "active" })
      const reviewNumbers = (await OrynGithubStore.list())
        .filter(
          (work) =>
            work.repository === input.repository &&
            work.mode === "review" &&
            active.some((record) => record.id === work.caseId && record.engineeringSessionId),
        )
        .map((work) => work.number)
      const numbers = [...new Set([...active.flatMap((record) => record.pullNumbers), ...reviewNumbers])].sort(
        (a, b) => a - b,
      )
      for (const number of numbers.slice(cursor.refreshOffset, cursor.refreshOffset + 5))
        await admit([await input.transport.current(input.repository, number, input.signal)])
      cursor = { ...cursor, refreshOffset: cursor.refreshOffset + 5 >= numbers.length ? 0 : cursor.refreshOffset + 5 }
      await OrynGithubStore.checkpoint(input.accountId, input.repository, cursor)
    }
    return true
  }

  export async function accept(input: {
    accountId: string
    repository: string
    repoAlias: string
    snapshot: GithubSnapshot
  }) {
    const bound = await binding(input.accountId, input.repository)
    if (!bound || bound.alias !== input.repoAlias) return
    const item = input.snapshot
    using lock = await Lock.write(`oryn-github-thread:${input.repository}:${item.number}`)
    const works = await OrynGithubStore.list()
    const existing = works.find(
      (work) =>
        work.mode !== "repair" &&
        work.repository === input.repository &&
        work.number === item.number &&
        work.accountId === input.accountId,
    )
    if (!existing) {
      const owner = (await OrynStore.listCases({ repoAlias: input.repoAlias })).find((record) =>
        item.kind === "pull" ? record.pullNumbers.includes(item.number) : record.issueNumber === item.number,
      )
      if (owner) {
        await OrynGithubOwned.observe(owner, item, input.repository)
        return owner.id
      }
    }
    if (!existing && item.state !== "open") return
    if (
      !existing &&
      item.kind === "pull" &&
      (item.draft ||
        (bound.config.github?.autoReview === false &&
          !item.comments.some((comment) => !comment.bot && /^@oryn\s+(review|fix)\s*$/i.test(comment.body.trim()))))
    )
      return
    const fingerprint = OrynGithubStore.fingerprint(item)
    if (existing) {
      if (Date.parse(item.updatedAt) < Date.parse(existing.snapshot.updatedAt)) return existing.caseId
      if (
        existing.mode === "issue" &&
        existing.fingerprint !== fingerprint &&
        existing.snapshot.state === "open" &&
        item.state === "open"
      ) {
        const record = await OrynStore.getCase(existing.caseId)
        if (record?.control === "active" && record.acceptanceDigest !== fingerprint)
          await OrynStore.mutateCase(record.id, record.revision, (value) => ({
            ...value,
            epoch: value.epoch + 1,
            acceptanceRevision: value.acceptanceRevision + 1,
            acceptanceDigest: fingerprint,
          }))
      }
      const state =
        (existing.state === "stopped" && existing.stoppedBy !== "closed") || item.state === "closed"
          ? "stopped"
          : existing.fingerprint !== fingerprint
            ? "queued"
            : existing.state
      await OrynGithubStore.save({
        ...existing,
        snapshot: item,
        fingerprint,
        state,
        stoppedBy: item.state === "closed" && existing.stoppedBy !== "command" ? "closed" : existing.stoppedBy,
        updatedAt: Date.now(),
      })
      return existing.caseId
    }
    const identity = {
      provider: "github" as const,
      accountId: input.accountId,
      repo: input.repository,
      chatId: `${input.repository}#${item.number}`,
      issueNumber: item.number,
    }
    const claimed = await OrynStore.claimSource({ identity, requestKey: "github-thread" })
    const key = sourceKey(identity)
    await OrynStore.recordSource({ identity })
    const record = await OrynStore.createCase({
      caseId: claimed.claim.caseId,
      kind: "bug",
      summary: item.title,
      observed: item.body.slice(0, 4000),
      repoAlias: input.repoAlias,
      sourceKeyHash: key,
    })
    await OrynStore.linkSourceToCase(key, record.id)
    if (item.kind === "issue") await OrynStore.attachRemoteRefs(record.id, { issueNumber: item.number })
    const work: GithubWork = {
      schemaVersion: 1,
      caseId: record.id,
      repoAlias: input.repoAlias,
      accountId: input.accountId,
      repository: input.repository,
      number: item.number,
      mode: item.kind === "pull" ? "review" : "issue",
      snapshot: item,
      fingerprint,
      attemptFingerprint: fingerprint,
      state: "queued",
      commandIds: [],
      updatedAt: Date.now(),
    }
    await OrynGithubStore.save(work)
    await OrynStore.updateClaim(key, "github-thread", { state: "completed" })
    return record.id
  }
}
