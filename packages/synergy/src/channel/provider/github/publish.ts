import { Log } from "@/util/log"
import { GitHubApiError, GitHubChannelAuth, buildCredentialCommand } from "./api"
import { record } from "./record"
import type { PublishExecuteInput, PublishExecuteResult, PublishFacts, PublishTransport } from "../../../oryn/publish"

const log = Log.create({ service: "channel.github.oryn-publish" })

/** Deterministic rejection: the remote branch diverged, so the push never applied. */
export class PublishNonFastForwardError extends Error {
  override readonly name = "PublishNonFastForwardError"
  constructor(branch: string, stderr: string) {
    super(`push to ${branch} rejected as non-fast-forward; human reconciliation required`)
    log.warn("oryn publish push rejected", { branch, stderr: stderr.slice(0, 300) })
  }
}

function splitRepository(repository: string): { owner: string; repo: string } {
  const [owner, repo, ...extra] = repository.split("/")
  if (!owner || !repo || extra.length > 0) throw new Error(`Invalid GitHub repository name: ${repository}`)
  return { owner, repo }
}

/**
 * Push the frozen candidate to the public branch. Pushing an explicit SHA to
 * `refs/heads/<branch>` is fast-forward-only by construction: GitHub rejects
 * diverged heads without `--force`, which this transport never passes.
 */
async function pushCandidate(input: {
  repository: string
  directory: string
  candidateSha: string
  branch: string
  signal?: AbortSignal
}): Promise<void> {
  const { owner, repo } = splitRepository(input.repository)
  const token = await GitHubChannelAuth.resolveInstallationToken(owner, repo, input.signal)
  const credential = buildCredentialCommand({ token, args: [] })
  const proc = Bun.spawn(
    ["git", ...credential.args, "push", "origin", `${input.candidateSha}:refs/heads/${input.branch}`],
    {
      cwd: input.directory,
      env: credential.env,
      stdout: "pipe",
      stderr: "pipe",
      ...(input.signal ? { signal: input.signal } : {}),
    },
  )
  const stderr = await new Response(proc.stderr).text()
  await new Response(proc.stdout).text()
  if (proc.exitCode !== 0) {
    if (/non-fast-forward|rejected|fetch first/i.test(stderr)) {
      throw new PublishNonFastForwardError(input.branch, stderr)
    }
    throw new Error(`git push failed for ${input.branch}: ${stderr.slice(0, 300)}`)
  }
}

const FAILING_CONCLUSIONS = new Set([
  "failure",
  "neutral",
  "cancelled",
  "timed_out",
  "action_required",
  "stale",
  "skipped",
])

function stringField(value: unknown, key: string): string | undefined {
  const raw = record(value)[key]
  return typeof raw === "string" ? raw : undefined
}

function numberField(value: unknown, key: string): number | undefined {
  const raw = record(value)[key]
  return typeof raw === "number" ? raw : undefined
}

/**
 * Provider-owned Oryn publish transport. The Host ledger resolves every
 * precondition and hands over a verified intent; this module holds the only
 * credential access — tokens are minted per call and never returned to
 * model callers.
 */
export namespace OrynGithubPublish {
  export function createTransport(): PublishTransport {
    return {
      async execute(input: PublishExecuteInput, signal?: AbortSignal): Promise<PublishExecuteResult> {
        const { owner, repo } = splitRepository(input.repository)
        const token = await GitHubChannelAuth.resolveInstallationToken(owner, repo, signal)
        const send = <T>(descriptor: Parameters<typeof GitHubChannelAuth.GitHubClient.send>[0]) =>
          GitHubChannelAuth.GitHubClient.send<T>(descriptor, signal)

        switch (input.operation) {
          case "ensure_issue": {
            const created = await send<unknown>(
              GitHubChannelAuth.GitHubClient.createIssue({
                owner,
                repo,
                title: input.title ?? "",
                body: input.body ?? "",
                installationToken: token,
              }),
            )
            const issueNumber = numberField(created, "number")
            if (!issueNumber) throw new Error("GitHub issue creation returned an invalid response")
            return { refs: { issueNumber, url: stringField(created, "html_url") } }
          }
          case "ensure_draft":
          case "refresh_pr": {
            if (!input.directory || !input.candidateSha || !input.branch) {
              throw new Error("branch push requires a workspace, candidate SHA, and branch")
            }
            await pushCandidate({
              repository: input.repository,
              directory: input.directory,
              candidateSha: input.candidateSha,
              branch: input.branch,
              signal,
            })
            if (input.operation === "ensure_draft") {
              const created = await send<unknown>(
                GitHubChannelAuth.GitHubClient.createPullRequest({
                  owner,
                  repo,
                  title: input.title ?? "",
                  body: input.body ?? "",
                  head: input.branch,
                  base: input.baseBranch ?? "dev",
                  draft: true,
                  installationToken: token,
                }),
              )
              const pullNumber = numberField(created, "number")
              if (!pullNumber) throw new Error("GitHub draft PR creation returned an invalid response")
              return { refs: { pullNumber, branch: input.branch, url: stringField(created, "html_url") } }
            }
            if (input.pullNumber && (input.title !== undefined || input.body !== undefined)) {
              await send<unknown>(
                GitHubChannelAuth.GitHubClient.updatePullRequest({
                  owner,
                  repo,
                  pullNumber: input.pullNumber,
                  ...(input.title !== undefined ? { title: input.title } : {}),
                  ...(input.body !== undefined ? { body: input.body } : {}),
                  installationToken: token,
                }),
              )
            }
            return { refs: { pullNumber: input.pullNumber, branch: input.branch } }
          }
          case "publish_review": {
            if (!input.pullNumber) throw new Error("publish_review requires a pull request number")
            await send<unknown>(
              GitHubChannelAuth.GitHubClient.createPullRequestReview({
                owner,
                repo,
                pullNumber: input.pullNumber,
                body: input.body ?? "",
                installationToken: token,
              }),
            )
            return { refs: { pullNumber: input.pullNumber } }
          }
          case "mark_ready": {
            if (!input.pullNumber || !input.candidateSha || !input.branch || !input.baseBranch || !input.marker) {
              throw new Error("mark_ready requires a bound pull request and frozen candidate")
            }
            const pull = await send<unknown>(
              GitHubChannelAuth.GitHubClient.getPullRequest({
                owner,
                repo,
                pullNumber: input.pullNumber,
                installationToken: token,
              }),
            )
            const slug = await GitHubChannelAuth.getAppSlug(signal)
            const nodeId = stringField(pull, "node_id")
            if (
              !nodeId ||
              numberField(pull, "number") !== input.pullNumber ||
              stringField(pull, "state") !== "open" ||
              typeof record(pull).draft !== "boolean" ||
              stringField(record(pull).head, "sha") !== input.candidateSha ||
              stringField(record(pull).head, "ref") !== input.branch ||
              stringField(record(pull).base, "ref") !== input.baseBranch ||
              stringField(record(record(pull).head).repo, "full_name") !== input.repository ||
              stringField(record(record(pull).base).repo, "full_name") !== input.repository ||
              stringField(record(pull).user, "login") !== `${slug}[bot]` ||
              !(stringField(pull, "body") ?? "").includes(input.marker)
            ) {
              throw new Error("pull request no longer matches the authorized Oryn candidate")
            }
            let url = stringField(pull, "html_url")
            try {
              if (record(pull).draft === true) {
                const response = await send<unknown>(
                  GitHubChannelAuth.GitHubClient.markPullRequestReadyForReview({
                    pullRequestId: nodeId,
                    installationToken: token,
                  }),
                )
                const changed = record(record(record(response).data).markPullRequestReadyForReview).pullRequest
                if (
                  record(response).errors !== undefined ||
                  stringField(changed, "id") !== nodeId ||
                  numberField(changed, "number") !== input.pullNumber ||
                  record(changed).isDraft !== false ||
                  stringField(changed, "state") !== "OPEN" ||
                  stringField(changed, "headRefOid") !== input.candidateSha ||
                  stringField(changed, "headRefName") !== input.branch ||
                  stringField(changed, "baseRefName") !== input.baseBranch
                ) {
                  throw new Error("ready mutation did not confirm the authorized candidate")
                }
                url = stringField(changed, "url")
              }
              const refs: PublishExecuteResult["refs"] = { pullNumber: input.pullNumber, url }
              if (input.deliveryCheckEnabled) {
                const run = await send<unknown>(
                  GitHubChannelAuth.GitHubClient.createCheckRun({
                    owner,
                    repo,
                    headSha: input.candidateSha,
                    name: "oryn/delivery",
                    conclusion: "success",
                    summary: input.body ?? "Oryn delivery gate passed",
                    installationToken: token,
                  }),
                )
                const checkRunId = numberField(run, "id")
                if (!checkRunId || !Number.isInteger(checkRunId) || checkRunId < 1) {
                  throw new Error("delivery check response has no valid ID")
                }
                refs.checkRunId = checkRunId
              }
              return { refs }
            } catch (error) {
              if (error instanceof GitHubApiError) throw error
              // Once a write starts, a transport or response-validation failure may follow a remote commit.
              throw new GitHubApiError(0, "POST", "/graphql", "Oryn readiness outcome requires reconciliation")
            }
          }
          case "notify_feishu": {
            // Feishu results flow through the oryn outbox, never GitHub.
            return { refs: {} }
          }
        }
      },

      async observe(input, signal?: AbortSignal): Promise<PublishFacts> {
        const { owner, repo } = splitRepository(input.repository)
        const token = await GitHubChannelAuth.resolveInstallationToken(owner, repo, signal)
        const send = <T>(descriptor: Parameters<typeof GitHubChannelAuth.GitHubClient.send>[0]) =>
          GitHubChannelAuth.GitHubClient.send<T>(descriptor, signal)
        const facts: PublishFacts = { ci: { state: "none" } }
        const slug = await GitHubChannelAuth.getAppSlug(signal)

        if (input.issueNumber) {
          const issue = await send<unknown>(
            GitHubChannelAuth.GitHubClient.getIssue({
              owner,
              repo,
              issueNumber: input.issueNumber,
              installationToken: token,
            }),
          )
          const body = stringField(issue, "body") ?? ""
          const login = stringField(record(issue).user, "login") ?? ""
          facts.issue = {
            number: input.issueNumber,
            title: stringField(issue, "title") ?? "",
            state: stringField(issue, "state") ?? "unknown",
            markerPresent: input.marker ? body.includes(input.marker) : false,
            authorIsApp: login === `${slug}[bot]`,
          }
        }
        if (input.pullNumber) {
          const pull = await send<unknown>(
            GitHubChannelAuth.GitHubClient.getPullRequest({
              owner,
              repo,
              pullNumber: input.pullNumber,
              installationToken: token,
            }),
          )
          const body = stringField(pull, "body") ?? ""
          const login = stringField(record(pull).user, "login") ?? ""
          facts.pull = {
            number: input.pullNumber,
            title: stringField(pull, "title") ?? "",
            draft: typeof record(pull).draft === "boolean" ? (record(pull).draft as boolean) : undefined,
            headSha: stringField(record(pull).head, "sha") ?? "",
            headBranch: stringField(record(pull).head, "ref") ?? "",
            baseRef: stringField(record(pull).base, "ref") ?? "",
            state: stringField(pull, "state") ?? "unknown",
            markerPresent: input.marker ? body.includes(input.marker) : false,
            authorIsApp: login === `${slug}[bot]`,
          }
        }
        if (input.ref) {
          const [status, runs] = await Promise.all([
            send<unknown>(
              GitHubChannelAuth.GitHubClient.getCombinedStatus({
                owner,
                repo,
                ref: input.ref,
                installationToken: token,
              }),
            ),
            (async () => {
              const runs: unknown[] = []
              for (let page = 1; page <= 100; page++) {
                const response = await GitHubChannelAuth.GitHubClient.sendPage<unknown>(
                  GitHubChannelAuth.GitHubClient.listCheckRunsForRef({
                    owner,
                    repo,
                    ref: input.ref!,
                    page,
                    installationToken: token,
                  }),
                  signal,
                )
                const batch = record(response.data).check_runs
                if (!Array.isArray(batch)) throw new Error("GitHub check list is malformed")
                runs.push(...batch)
                if (!(response.headers.get("link") ?? "").includes('rel="next"')) {
                  const total = numberField(response.data, "total_count")
                  if (total !== undefined && total > runs.length) throw new Error("GitHub check list is incomplete")
                  return runs
                }
              }
              throw new Error("GitHub check pagination limit exceeded")
            })(),
          ])
          let signals = 0
          let failing = false
          let allSuccess = true
          const statusState = stringField(status, "state")
          const statusCount =
            numberField(status, "total_count") ??
            (Array.isArray(record(status).statuses) ? (record(status).statuses as unknown[]).length : undefined)
          if (statusCount === undefined) throw new Error("GitHub combined status is malformed")
          if (statusCount > 0) {
            signals++
            if (statusState === "success") {
              // success contributes no failure
            } else if (statusState === "failure" || statusState === "error") {
              failing = true
              allSuccess = false
            } else {
              allSuccess = false
            }
          }
          for (const run of runs) {
            const conclusion = stringField(run, "conclusion")
            if (stringField(run, "name") === "oryn/delivery" && stringField(record(run).app, "slug") === slug) {
              const checkRunId = numberField(run, "id")
              if (
                checkRunId &&
                record(run).status === "completed" &&
                conclusion === "success" &&
                stringField(run, "head_sha") === input.ref
              ) {
                facts.delivery = { checkRunId, headSha: input.ref }
              }
              continue
            }
            signals++
            if (record(run).status !== "completed" || !conclusion) {
              allSuccess = false
            } else if (FAILING_CONCLUSIONS.has(conclusion)) {
              failing = true
              allSuccess = false
            } else if (conclusion !== "success") {
              allSuccess = false
            }
          }
          facts.ci = { state: signals === 0 ? "none" : failing ? "failure" : allSuccess ? "success" : "pending" }
        }
        return facts
      },
    }
  }
}

/** Injected by the Oryn domain so the poll loop can reconcile the action ledger without importing it. */
let pollReconciler: (() => Promise<void>) | undefined

export function setGithubPollReconciler(fn: () => Promise<void>): void {
  pollReconciler = fn
}

export async function runGithubPollReconciler(): Promise<void> {
  if (!pollReconciler) return
  try {
    await pollReconciler()
  } catch (error) {
    log.warn("oryn action reconciliation failed", { error })
  }
}
