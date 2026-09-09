import { expect, spyOn, test } from "bun:test"
import { fetchOrynReview } from "../../../../src/channel/provider/github/oryn-fetch"
import { GitHubChannelAuth } from "../../../../src/channel/provider/github/api"
import { OrynGit } from "../../../../src/oryn/git"
import { tmpdir } from "../../../fixture/fixture"

test("fixed objects already in the trusted cache are pinned without downloading repository history again", async () => {
  await using repo = await tmpdir({ git: true })
  const sha = await OrynGit.read(repo.path, ["rev-parse", "HEAD"])
  using token = spyOn(GitHubChannelAuth, "resolveInstallationToken").mockImplementation(async () => {
    throw new Error("Cached objects must not request credentials")
  })
  await fetchOrynReview({ repository: "acme/fixture", directory: repo.path, headSha: sha, baseSha: sha })
  expect(token).not.toHaveBeenCalled()
  expect(await OrynGit.read(repo.path, ["rev-parse", `refs/oryn/objects/${sha}`])).toBe(sha)
})
