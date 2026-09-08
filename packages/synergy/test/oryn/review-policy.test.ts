import { expect, test } from "bun:test"
import { OrynReviewPolicy } from "../../src/oryn/review-policy"
import { OrynGit } from "../../src/oryn/git"
import { tmpdir } from "../fixture/fixture"

test("a rename out of a sensitive directory retains the deleted path's review requirement", async () => {
  await using repo = await tmpdir({ git: true })
  await Bun.write(`${repo.path}/src/security/check.ts`, "export const check = () => true\n")
  await Bun.$`git add -- src/security/check.ts`.cwd(repo.path).quiet()
  await Bun.$`git commit -m "test: initial security path"`.cwd(repo.path).quiet()
  const baseline = await OrynGit.read(repo.path, ["rev-parse", "HEAD"])
  await Bun.$`git mv src/security/check.ts src/ordinary.ts`.cwd(repo.path).quiet()
  await Bun.$`git commit -m "test: move security path"`.cwd(repo.path).quiet()
  const candidate = await OrynGit.read(repo.path, ["rev-parse", "HEAD"])
  const changes = await OrynGit.changes(repo.path, baseline, candidate)
  expect(changes).toContainEqual({ status: "D", path: "src/security/check.ts" })
  expect(OrynReviewPolicy.classify(changes)).toEqual(["general", "security"])
})

test.each([
  ["src/widget.ts", ["general"]],
  ["packages/synergy/src/oryn/schema.ts", ["general", "security", "publishing"]],
  ["db/migrations/one.sql", ["general", "persistence"]],
  [".github/workflows/ci.yml", ["general", "security", "publishing"]],
  [".synergy/skill/review/SKILL.md", ["general", "security"]],
  ["package.json", ["general", "security"]],
  ["src/channel/feishu.ts", ["general", "channel"]],
] as const)("Host policy classifies %s", (file, expected) => {
  expect(OrynReviewPolicy.classify([{ path: file, status: "M" }])).toEqual([...expected])
})
