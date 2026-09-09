import { expect, test } from "bun:test"
import { OrynIntegration } from "../../src/oryn/integration"
import { OrynGit } from "../../src/oryn/git"
import { tmpdir } from "../fixture/fixture"

test("integration detects real conflicts without modifying a compatible head", async () => {
  await using repo = await tmpdir({ git: true })
  await Bun.write(`${repo.path}/value.txt`, "original\n")
  await Bun.$`git add value.txt`.cwd(repo.path).quiet()
  await Bun.$`git commit -m original`.cwd(repo.path).quiet()
  const base = await OrynGit.read(repo.path, ["rev-parse", "HEAD"])
  await Bun.$`git checkout -b topic`.cwd(repo.path).quiet()
  await Bun.write(`${repo.path}/value.txt`, "topic\n")
  await Bun.$`git commit -am topic`.cwd(repo.path).quiet()
  const head = await OrynGit.read(repo.path, ["rev-parse", "HEAD"])
  await Bun.$`git checkout -b target ${base}`.cwd(repo.path).quiet()
  await Bun.write(`${repo.path}/other.txt`, "target\n")
  await Bun.$`git add other.txt`.cwd(repo.path).quiet()
  await Bun.$`git commit -m target`.cwd(repo.path).quiet()
  const compatible = await OrynGit.read(repo.path, ["rev-parse", "HEAD"])
  expect((await OrynIntegration.inspect(repo.path, head, compatible)).conflicts).toEqual([])
  await Bun.write(`${repo.path}/value.txt`, "conflict\n")
  await Bun.$`git commit -am conflict`.cwd(repo.path).quiet()
  const target = await OrynGit.read(repo.path, ["rev-parse", "HEAD"])
  expect((await OrynIntegration.inspect(repo.path, head, target)).conflicts).toEqual(["value.txt"])
  expect(await OrynGit.read(repo.path, ["rev-parse", "HEAD"])).toBe(target)
})
