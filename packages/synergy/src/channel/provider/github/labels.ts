import { GitHubApiError, GitHubChannelAuth } from "./api"
import { record } from "./record"
import { LabelTarget, OrynLabel } from "../../../oryn/schema"
import { OrynLabels, type LabelRead, type LabelTransport, type LabelSnapshot } from "../../../oryn/labels"
import { OrynLabelCatalog } from "../../../oryn/label-catalog"

export namespace OrynGithubLabels {
  export function createTransport(): LabelTransport {
    async function client(input: LabelRead) {
      LabelTarget.parse({
        repository: input.repository,
        number: input.number,
        kind: input.kind,
        labels: input.labels,
        candidateSha: input.candidateSha,
        baseBranch: input.baseBranch,
      })
      const [owner, repo] = input.repository.split("/") as [string, string]
      const installationToken = await GitHubChannelAuth.resolveInstallationToken(owner, repo)
      return { owner, repo, installationToken }
    }
    const send = <T>(request: Parameters<typeof GitHubChannelAuth.GitHubClient.send>[0]) =>
      GitHubChannelAuth.GitHubClient.send<T>(request)
    async function observe(input: LabelRead): Promise<LabelSnapshot> {
      const auth = await client(input)
      const slug = input.tracked ? undefined : await GitHubChannelAuth.getAppSlug()
      if (!input.tracked && (!slug || !input.marker || !input.branch)) return { owned: false, labels: [] }
      const entity = record(
        await send<unknown>(
          input.kind === "pull"
            ? GitHubChannelAuth.GitHubClient.getPullRequest({ ...auth, pullNumber: input.number })
            : GitHubChannelAuth.GitHubClient.getIssue({ ...auth, issueNumber: input.number }),
        ),
      )
      const common =
        entity.number === input.number &&
        entity.state === "open" &&
        (input.tracked ||
          (record(entity.user).login === `${slug}[bot]` &&
            typeof entity.body === "string" &&
            entity.body.includes(input.marker)))
      const head = record(entity.head)
      const base = record(entity.base)
      const owned =
        common &&
        (input.kind === "issue"
          ? !entity.pull_request
          : Boolean(input.candidateSha) &&
            head.sha === input.candidateSha &&
            (input.tracked || head.ref === input.branch) &&
            base.ref === input.baseBranch &&
            (input.tracked || record(head.repo).full_name === input.repository) &&
            record(base.repo).full_name === input.repository)
      if (!owned) return { owned: false, labels: [] }
      const labels: string[] = []
      for (let page = 1; page <= 10; page++) {
        const batch = await send<unknown>(
          GitHubChannelAuth.GitHubClient.listIssueLabels({ ...auth, issueNumber: input.number, page }),
        )
        if (!Array.isArray(batch) || batch.some((item) => typeof record(item).name !== "string"))
          throw new Error("GitHub label response is incomplete")
        labels.push(...batch.map((item) => record(item).name as string))
        if (batch.length < 100) return { owned: true, labels }
      }
      throw new Error("GitHub label pagination exceeded its bound")
    }
    return {
      observe,
      async apply(input) {
        const auth = await client(input)
        for (const label of [...input.add, ...input.remove]) OrynLabel.parse(label)
        // GitHub POST adds labels; PUT replaces all labels. Preserve unrelated and human-priority labels.
        // https://docs.github.com/en/rest/issues/labels
        for (let step = 0; step < OrynLabel.options.length; step++) {
          const current = await observe(input)
          if (!current.owned) throw new Error("GitHub label target is no longer owned by this Case")
          const delta = OrynLabels.delta(current.labels, input.labels)
          if (!delta.add.length && !delta.remove.length) return
          await input.beforeWrite()
          if (delta.add.length) {
            await send(
              GitHubChannelAuth.GitHubClient.addIssueLabels({
                ...auth,
                issueNumber: input.number,
                labels: delta.add.map((id) => OrynLabelCatalog.definitions[id].name),
              }),
            )
            continue
          }
          try {
            await send(
              GitHubChannelAuth.GitHubClient.removeIssueLabel({
                ...auth,
                issueNumber: input.number,
                name: current.labels.find((name) => OrynLabelCatalog.id(name) === delta.remove[0])!,
              }),
            )
          } catch (error) {
            if (!(error instanceof GitHubApiError) || error.status !== 404) throw error
          }
        }
        throw new Error("GitHub labels kept changing during synchronization")
      },
    }
  }
}
