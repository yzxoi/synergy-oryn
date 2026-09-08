import { expect, test } from "bun:test"
import { OrynDiscovery } from "../../src/oryn/discovery"
import { OrynGithub } from "../../src/oryn/github"
import { OrynStore } from "../../src/oryn/store"
import { githubConfig as globalConfig } from "./fixture"

test("discoveries preserve lineage, deduplicate reproduction work and retain private or over-budget findings for humans", async () => {
  const repo = `r${crypto.randomUUID()}`
  await using config = await globalConfig({
    oryn: {
      enabled: true,
      limits: { maxDescendants: 1 },
      repositories: { target: { owner: "acme", repo, githubAccount: "app", github: { enabled: true } } },
    },
  })
  const caseId = (await OrynGithub.accept({
    accountId: "app",
    repository: `acme/${repo}`,
    repoAlias: "target",
    snapshot: {
      number: 5,
      kind: "issue",
      title: "Initial bug",
      body: "Evidence",
      state: "open",
      updatedAt: new Date().toISOString(),
      labels: [],
      comments: [],
    },
  }))!
  const parent = (await OrynStore.getCase(caseId))!
  const source = (await OrynStore.getSource(parent.sourceIds[0]!))!
  const sessionID = `discovery-${crypto.randomUUID()}`
  await OrynStore.attachEngineeringSession(caseId, sessionID)
  await OrynStore.bindSessionSource({ sessionID, identity: source.identity, caseId, role: "engineering" })
  const input = {
    caseId,
    relation: "independent" as const,
    summary: "Another bug",
    observed: repo + " loses data",
    expected: "Retain data",
    evidenceRefs: [],
  }
  await expect(OrynDiscovery.propose("foreign", input)).rejects.toBeDefined()
  const first = await OrynDiscovery.propose(sessionID, input)
  expect(first.rootCaseId).toBe(caseId)
  expect(first.childCaseId).toBeDefined()
  expect((await OrynStore.getCase(first.childCaseId!))?.issueNumber).toBeUndefined()
  expect((await OrynDiscovery.propose(sessionID, input)).childCaseId).toBe(first.childCaseId)
  const blocked = await OrynDiscovery.propose(sessionID, { ...input, observed: "A different independent bug" })
  expect(blocked.state).toBe("needs_human")
  expect(blocked.childCaseId).toBeUndefined()
  const security = await OrynDiscovery.propose(sessionID, { ...input, relation: "security" })
  expect(security.childCaseId).toBeUndefined()
  const local = await OrynDiscovery.propose(sessionID, { ...input, relation: "current_change" })
  expect(local.childCaseId).toBeUndefined()
  await OrynDiscovery.recover()
  expect((await OrynStore.getCase(first.childCaseId!))?.sourceIds).toEqual(parent.sourceIds)
})
