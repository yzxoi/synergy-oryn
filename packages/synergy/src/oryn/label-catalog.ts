import { OrynLabel } from "./schema"

export namespace OrynLabelCatalog {
  export const definitions = {
    "oryn:type/bug": { name: "🐛 oryn:type/bug", color: "d73a4a", description: "Bug report or fix" },
    "oryn:type/feature": {
      name: "✨ oryn:type/feature",
      color: "a2eeef",
      description: "Feature request or implementation",
    },
    "oryn:type/question": {
      name: "❓ oryn:type/question",
      color: "d876e3",
      description: "Question requiring an answer",
    },
    "oryn:type/performance": {
      name: "⚡ oryn:type/performance",
      color: "fbca04",
      description: "Performance investigation or improvement",
    },
    "oryn:type/usage": { name: "🧭 oryn:type/usage", color: "0075ca", description: "Usage or configuration help" },
    "oryn:status/triage": { name: "🔎 oryn:status/triage", color: "c5def5", description: "Queued or being triaged" },
    "oryn:status/reproducing": {
      name: "🧪 oryn:status/reproducing",
      color: "bfdadc",
      description: "Reproducing the reported behavior",
    },
    "oryn:status/coding": {
      name: "🛠️ oryn:status/coding",
      color: "5319e7",
      description: "Implementing a candidate fix",
    },
    "oryn:status/verifying": {
      name: "🔬 oryn:status/verifying",
      color: "1d76db",
      description: "Verifying the candidate against accepted checks",
    },
    "oryn:status/reviewing": {
      name: "👀 oryn:status/reviewing",
      color: "7057ff",
      description: "Independent review in progress",
    },
    "oryn:status/needs-human": {
      name: "🙋 oryn:status/needs-human",
      color: "e99695",
      description: "Human input or intervention needed",
    },
    "oryn:status/ready": {
      name: "🎉 oryn:status/ready",
      color: "0e8a16",
      description: "Ready for human attention; does not grant merge authority",
    },
    "oryn:priority/untriaged": {
      name: "🏷️ oryn:priority/untriaged",
      color: "ededed",
      description: "Priority has not been assigned",
    },
    "oryn:priority/p0": { name: "🚨 oryn:priority/p0", color: "b60205", description: "Critical priority" },
    "oryn:priority/p1": { name: "🔥 oryn:priority/p1", color: "d93f0b", description: "High priority" },
    "oryn:priority/p2": { name: "📌 oryn:priority/p2", color: "fbca04", description: "Normal priority" },
    "oryn:priority/p3": { name: "🌱 oryn:priority/p3", color: "c2e0c6", description: "Low priority" },
  } satisfies Record<OrynLabel, { name: string; color: string; description: string }>

  export function id(name: string): OrynLabel | undefined {
    const canonical = OrynLabel.safeParse(name)
    if (canonical.success) return canonical.data
    return OrynLabel.options.find((id) => definitions[id].name === name)
  }
}
