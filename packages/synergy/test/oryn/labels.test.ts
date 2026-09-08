import { describe, expect, test } from "bun:test"
import { OrynLabels, setLabelTransport, type LabelSnapshot } from "../../src/oryn/labels"
import { Case, Attempt, Assignment } from "../../src/oryn/schema"
import { OrynStore } from "../../src/oryn/store"
import { Config } from "../../src/config/config"
import { tmpdir } from "./fixture"

const record = Case.parse({
  schemaVersion: 2,
  id: "case-labels",
  revision: 0,
  kind: "bug",
  summary: "A reported bug",
  repoAlias: "widget",
  acceptanceDigest: "accepted",
  activeAttemptId: "attempt",
  createdAt: 1,
  updatedAt: 1,
})
const attempt = Attempt.parse({
  schemaVersion: 1,
  id: "attempt",
  caseId: record.id,
  revision: 0,
  baselineSha: "a".repeat(40),
  createdAt: 1,
  updatedAt: 1,
})
const worker = Assignment.parse({
  schemaVersion: 1,
  id: "assignment",
  caseId: record.id,
  attemptId: attempt.id,
  stage: "code",
  agentId: "oryn-code",
  sessionId: "worker",
  requestKey: "assign",
  frozenInputsDigest: "frozen",
  epoch: 0,
  updatedAt: 1,
  createdAt: 1,
})

describe("Oryn label projection", () => {
  test("derives progress from current assignments and preserves an unknown priority", () => {
    expect(OrynLabels.project(record, attempt, [])).toEqual([
      "oryn:type/bug",
      "oryn:status/triage",
      "oryn:priority/untriaged",
    ])
    expect(OrynLabels.project(record, attempt, [worker])).toContain("oryn:status/coding")
    expect(OrynLabels.project(record, { ...attempt, disposition: "ready" }, [worker])).toContain("oryn:status/ready")
    expect(OrynLabels.project(record, attempt, [{ ...worker, epoch: 999 }])).not.toContain("oryn:status/coding")
  })

  test("updates only owned type/status labels and preserves human priority", () => {
    const delta = OrynLabels.delta(
      ["help wanted", "oryn:type/feature", "oryn:status/triage", "oryn:priority/p1", "oryn:custom"],
      ["oryn:type/bug", "oryn:status/coding", "oryn:priority/untriaged"],
    )
    expect(delta).toEqual({
      add: ["oryn:type/bug", "oryn:status/coding"],
      remove: ["oryn:type/feature", "oryn:status/triage"],
    })
    expect(
      OrynLabels.delta(
        ["oryn:type/bug", "oryn:status/coding", "oryn:priority/p1"],
        ["oryn:type/bug", "oryn:status/coding", "oryn:priority/untriaged"],
      ),
    ).toEqual({ add: [], remove: [] })
  })
})

async function fixture(
  fn: (value: Case, remote: { labels: string[]; writes: number; lose: boolean }) => Promise<void>,
) {
  await using tmp = await tmpdir({
    config: {
      oryn: {
        enabled: true,
        routes: [{ feishuAccount: "fixture", repoAlias: "widget" }],
        repositories: { widget: { owner: "acme", repo: "widget", labels: true } },
      },
    },
  })
  const value = await OrynStore.createCase({
    caseId: `labels-${crypto.randomUUID()}`,
    kind: "bug",
    summary: "label fixture",
    repoAlias: "widget",
    sourceKeyHash: "fixture",
  })
  await OrynStore.attachRemoteRefs(value.id, { issueNumber: 12 })
  const remote = { labels: ["human-label"], writes: 0, lose: false }
  setLabelTransport({
    async observe(): Promise<LabelSnapshot> {
      return { labels: [...remote.labels], owned: true }
    },
    async apply(input) {
      expect(
        (await OrynStore.listActions({ caseId: value.id })).some(
          (action) => action.operation === "sync_labels" && action.state === "in_flight",
        ),
      ).toBe(true)
      await input.beforeWrite()
      remote.writes++
      remote.labels = [
        ...remote.labels.filter((label) => !input.remove.some((removed) => removed === label)),
        ...input.add,
      ]
      if (remote.lose) {
        remote.lose = false
        throw new TypeError("lost label response")
      }
    },
  })
  try {
    await fn((await OrynStore.getCase(value.id))!, remote)
  } finally {
    setLabelTransport(undefined)
  }
}

test("lost label response reconciles without replay or pausing engineering", async () => {
  await fixture(async (value, remote) => {
    remote.lose = true
    await OrynLabels.syncCase(value.id)
    expect((await OrynStore.listActions({ caseId: value.id }))[0]?.state).toBe("ambiguous")
    expect((await OrynStore.getCase(value.id))?.control).toBe("active")
    await OrynLabels.syncCase(value.id)
    expect(remote.writes).toBe(1)
    expect((await OrynStore.listActions({ caseId: value.id }))[0]?.state).toBe("acknowledged")
    expect(remote.labels).toContain("human-label")
  })
})

test("takeover between observation and mutation prevents label writes", async () => {
  await fixture(async (value, remote) => {
    setLabelTransport({
      async observe() {
        const fresh = (await OrynStore.getCase(value.id))!
        await OrynStore.control(value.id, fresh.revision, "takeover")
        return { labels: [], owned: true }
      },
      async apply() {
        remote.writes++
      },
    })
    await OrynLabels.syncCase(value.id)
    expect(remote.writes).toBe(0)
  })
})

test("foreign objects cannot be relabeled even if their marker was copied", async () => {
  await fixture(async (value, remote) => {
    setLabelTransport({
      async observe() {
        return { labels: [], owned: false }
      },
      async apply() {
        remote.writes++
      },
    })
    await OrynLabels.syncCase(value.id)
    expect(remote.writes).toBe(0)
  })
})

test("persistent label failures are bounded and do not stop the Case", async () => {
  await fixture(async (value, remote) => {
    setLabelTransport({
      async observe() {
        return { labels: [], owned: true }
      },
      async apply(input) {
        await input.beforeWrite()
        remote.writes++
        throw new Error("missing repository labels")
      },
    })
    for (let index = 0; index < 5; index++) await OrynLabels.syncCase(value.id)
    expect(remote.writes).toBe(3)
    expect((await OrynStore.getCase(value.id))?.control).toBe("active")
    expect((await OrynStore.listActions({ caseId: value.id }))[0]?.attempts).toBe(3)
  })
})

test("an interrupted in-flight label action settles from remote facts", async () => {
  await fixture(async (value, remote) => {
    await OrynLabels.syncCase(value.id)
    const action = (await OrynStore.listActions({ caseId: value.id }))[0]!
    await OrynStore.mutateAction(action.id, (item) => ({ ...item, state: "in_flight" }))
    await OrynLabels.syncCase(value.id)
    expect(remote.writes).toBe(1)
    expect((await OrynStore.getAction(action.id))?.state).toBe("acknowledged")
  })
})

test("repository label synchronization requires explicit installation opt-in", async () => {
  await fixture(async (value, remote) => {
    const config = await Config.globalRaw()
    await Config.domainUpdate("runtime", {
      oryn: {
        ...config.oryn!,
        repositories: {
          ...config.oryn!.repositories,
          widget: { ...config.oryn!.repositories!.widget!, labels: false },
        },
      },
    })
    await OrynLabels.syncCase(value.id)
    expect(remote.writes).toBe(0)
  })
})
