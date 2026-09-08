import { z } from "zod"
import { Storage } from "../storage/storage"
import { REVIEW_POLICY_VERSION } from "./schema"
import { OrynPath } from "./path"
import { externalIdentityHash } from "../util/identity"

export const GithubSnapshot = z
  .object({
    number: z.number().int().positive(),
    kind: z.enum(["issue", "pull"]),
    title: z.string().max(2000),
    body: z.string().max(20000),
    state: z.enum(["open", "closed"]),
    updatedAt: z.string(),
    labels: z.array(z.string()).max(100),
    draft: z.boolean().optional(),
    merged: z.boolean().optional(),
    headSha: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .optional(),
    baseSha: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .optional(),
    baseRef: z.string().optional(),
    comments: z
      .array(
        z.object({
          id: z.number().int(),
          body: z.string().max(10000),
          login: z.string(),
          updatedAt: z.string(),
          bot: z.boolean(),
        }),
      )
      .max(100),
  })
  .strict()
export type GithubSnapshot = z.infer<typeof GithubSnapshot>

export const GithubWork = z
  .object({
    schemaVersion: z.literal(1),
    caseId: z.string(),
    repoAlias: z.string(),
    accountId: z.string(),
    repository: z.string(),
    number: z.number().int().positive(),
    mode: z.enum(["issue", "review", "repair"]),
    snapshot: GithubSnapshot,
    fingerprint: z.string(),
    attemptFingerprint: z.string().optional(),
    state: z.enum(["queued", "running", "settled", "stopped"]),
    stoppedBy: z.enum(["command", "closed"]).optional(),
    suspendedEpoch: z.number().int().optional(),
    reviewPublication: z
      .object({
        fingerprint: z.string(),
        marker: z.string(),
        body: z.string(),
        state: z.enum(["prepared", "ambiguous", "acknowledged"]),
        remoteId: z.number().optional(),
      })
      .optional(),
    reviewHistory: z
      .array(
        z.object({
          fingerprint: z.string(),
          marker: z.string(),
          state: z.enum(["ambiguous", "acknowledged"]),
          remoteId: z.number().optional(),
        }),
      )
      .optional(),
    commandIds: z.array(z.string()),
    repairCaseId: z.string().optional(),
    parentReviewCaseId: z.string().optional(),
    authorizedBy: z.string().optional(),
    failure: z.object({ attempts: z.number().int(), retryAt: z.number(), reason: z.string() }).optional(),
    updatedAt: z.number(),
  })
  .strict()
export type GithubWork = z.infer<typeof GithubWork>

const Cursor = z
  .object({
    schemaVersion: z.literal(1),
    page: z.number().int().positive(),
    since: z.string(),
    startedAt: z.string(),
    initialized: z.boolean(),
    refreshOffset: z.number().int().nonnegative().default(0),
    backfillPage: z.number().int().positive().default(1),
    backfillEnabled: z.boolean().default(true),
    reconcileAt: z.number(),
  })
  .strict()
export type GithubCursor = z.infer<typeof Cursor>

async function read<T>(key: string[], schema: z.ZodType<T>) {
  try {
    return schema.parse(await Storage.read(key))
  } catch (error) {
    if (error instanceof Storage.NotFoundError) return undefined
    throw error
  }
}

export namespace OrynGithubStore {
  export const get = (caseId: string) => read(OrynPath.githubWork(caseId), GithubWork)
  export async function save(work: GithubWork) {
    await Storage.write(OrynPath.githubWork(work.caseId), GithubWork.parse(work))
    return work
  }
  export async function list() {
    const ids = await Storage.scan(OrynPath.githubRoot())
    const records = await Promise.all(ids.map(get))
    return records.filter((x): x is GithubWork => !!x)
  }
  export const cursor = (account: string, repo: string) =>
    read(OrynPath.githubCursor(externalIdentityHash(account, repo)), Cursor)
  export async function checkpoint(account: string, repo: string, value: GithubCursor) {
    await Storage.write(OrynPath.githubCursor(externalIdentityHash(account, repo)), Cursor.parse(value))
  }
  export function fingerprint(item: GithubSnapshot) {
    return externalIdentityHash(
      REVIEW_POLICY_VERSION,
      item.kind,
      item.headSha ?? "",
      item.baseSha ?? "",
      item.title,
      item.body,
      String(item.draft ?? false),
      String(item.merged ?? false),
      item.state,
      JSON.stringify(item.comments.filter((comment) => !comment.bot)),
    )
  }
}
