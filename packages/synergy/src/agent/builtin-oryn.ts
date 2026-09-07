import { PermissionNext } from "@/permission/next"
import type { Agent } from "./agent"
import { resolveAgentModelRole, type BuiltinAgentContext } from "./builtin-context"
import PROMPT_ORYN_QA from "./prompt/oryn/qa.txt"
import PROMPT_ORYN_WORK from "./prompt/oryn/work.txt"
import PROMPT_ORYN_REPRO from "./prompt/oryn/repro.txt"
import PROMPT_ORYN_CODE from "./prompt/oryn/code.txt"
import PROMPT_ORYN_REVIEW from "./prompt/oryn/review.txt"

const READ_TOOLS = ["read", "glob", "grep", "ast_grep", "view_file", "scan_files", "parse_code"]

type Rule = { permission: string; pattern: string; action: "allow" | "deny" | "ask" }

function denyAll(): Rule {
  return { permission: "*", pattern: "*", action: "deny" }
}

function sensitiveReadDenies(): Rule[] {
  return [
    { permission: "read", pattern: "*.env", action: "deny" },
    { permission: "read", pattern: "*.env.*", action: "deny" },
    { permission: "read", pattern: ".env", action: "deny" },
    { permission: "read", pattern: "*.pem", action: "deny" },
    { permission: "read", pattern: "*.key", action: "deny" },
    { permission: "read", pattern: "*_rsa", action: "deny" },
    { permission: "read", pattern: "*credentials*", action: "deny" },
    { permission: "read", pattern: "*secret*", action: "deny" },
  ]
}

/**
 * Oryn permission clamp. PermissionNext.evaluate picks the LAST matching
 * rule, and the clamp is merged after the user ruleset
 * (merge(defaults, user, clamp)), so an installation's own config can never
 * expand the Oryn host capability ceiling: any tool outside the allow list
 * falls through to the leading deny-all, which sits after every user rule.
 * Inside the clamp the order is deny-all, specific allows, sensitive-read
 * denies last so credential files stay unreadable even though "read" itself
 * is allowed.
 */
function clamp(allows: Rule[]): PermissionNext.Ruleset {
  return [denyAll(), ...allows, ...sensitiveReadDenies()] as PermissionNext.Ruleset
}

function readAllows(): Rule[] {
  return READ_TOOLS.map((tool) => ({ permission: tool, pattern: "*", action: "allow" as const }))
}

function toolAllows(tools: string[]): Rule[] {
  return tools.map((tool) => ({ permission: tool, pattern: "*", action: "allow" as const }))
}

const QA_TOOLS = ["skill", "memory_search", "memory_get", "oryn_case", "oryn_reply", "oryn_github_read"]
const WORK_TOOLS = [
  "skill",
  "memory_search",
  "memory_get",
  "boss_status",
  "session_read",
  "oryn_case",
  "oryn_dispatch",
  "oryn_result",
  "oryn_check",
  "oryn_publish",
  "oryn_github_read",
]
const REPRO_TOOLS = [
  "skill",
  "memory_search",
  "memory_get",
  "edit",
  "write",
  "bash",
  "process",
  "boss_report",
  "oryn_case",
  "oryn_check",
  "oryn_result",
  "oryn_github_read",
]
const CODE_TOOLS = [
  "skill",
  "memory_search",
  "memory_get",
  "edit",
  "write",
  "bash",
  "process",
  "boss_report",
  "oryn_case",
  "oryn_check",
  "oryn_result",
  "oryn_github_read",
]
const REVIEW_TOOLS = [
  "memory_search",
  "memory_get",
  "session_read",
  "boss_report",
  "oryn_case",
  "oryn_check",
  "oryn_result",
  "oryn_github_read",
]

export function createBuiltinOrynAgents(ctx: BuiltinAgentContext): Record<string, Agent.Info> {
  const qa: Agent.Info = {
    name: "oryn",
    description: "Oryn user-support engineer bound by the Host to one Feishu thread",
    mode: "primary",
    hidden: true,
    native: true,
    prompt: PROMPT_ORYN_QA,
    permission: PermissionNext.merge(ctx.defaults, ctx.user, clamp([...readAllows(), ...toolAllows(QA_TOOLS)])),
    options: {},
    ...resolveAgentModelRole(ctx, "mid"),
  }
  const work: Agent.Info = {
    name: "oryn-work",
    description: "Oryn engineering lead for one case; the only dispatcher of Oryn workers",
    mode: "primary",
    hidden: true,
    native: true,
    prompt: PROMPT_ORYN_WORK,
    permission: PermissionNext.merge(ctx.defaults, ctx.user, clamp([...readAllows(), ...toolAllows(WORK_TOOLS)])),
    options: {},
    ...resolveAgentModelRole(ctx, "thinking"),
  }
  const repro: Agent.Info = {
    name: "oryn-repro",
    description: "Oryn test engineer for reproduction and independent verification",
    mode: "subagent",
    visibleTo: ["oryn-work"],
    prompt: PROMPT_ORYN_REPRO,
    permission: PermissionNext.merge(ctx.defaults, ctx.user, clamp([...readAllows(), ...toolAllows(REPRO_TOOLS)])),
    options: {},
    ...resolveAgentModelRole(ctx, "mid"),
  }
  const code: Agent.Info = {
    name: "oryn-code",
    description: "Oryn developer with an exclusive candidate worktree per assignment",
    mode: "subagent",
    visibleTo: ["oryn-work"],
    prompt: PROMPT_ORYN_CODE,
    permission: PermissionNext.merge(ctx.defaults, ctx.user, clamp([...readAllows(), ...toolAllows(CODE_TOOLS)])),
    options: {},
    ...resolveAgentModelRole(ctx, "thinking"),
  }
  const review: Agent.Info = {
    name: "oryn-review",
    description: "Oryn independent reviewer; cannot edit candidates or clear findings itself",
    mode: "subagent",
    visibleTo: ["oryn-work"],
    prompt: PROMPT_ORYN_REVIEW,
    permission: PermissionNext.merge(ctx.defaults, ctx.user, clamp([...readAllows(), ...toolAllows(REVIEW_TOOLS)])),
    options: {},
    ...resolveAgentModelRole(ctx, "thinking"),
  }
  return { [qa.name]: qa, [work.name]: work, [repro.name]: repro, [code.name]: code, [review.name]: review }
}

const CEILING: Record<string, ReadonlySet<string>> = {
  oryn: new Set([...READ_TOOLS, ...QA_TOOLS]),
  "oryn-work": new Set([...READ_TOOLS, ...WORK_TOOLS]),
  "oryn-repro": new Set([...READ_TOOLS, ...REPRO_TOOLS]),
  "oryn-code": new Set([...READ_TOOLS, ...CODE_TOOLS]),
  "oryn-review": new Set([...READ_TOOLS, ...REVIEW_TOOLS]),
}

/**
 * Re-enforce the Oryn capability ceiling after per-agent user config and the
 * generic patch loops in Agent.list append rules beyond the clamp. Rules
 * appended after the clamp's deny-all would expand access (evaluate picks
 * the last match), so allow rules for tools outside the ceiling are dropped;
 * ask/deny tightening from operators is preserved, and the sensitive-read
 * denies are re-seated last so credential files stay unreadable even when a
 * user rule allows "read" broadly.
 */
export function enforceOrynCeiling(agent: Agent.Info): void {
  const ceiling = CEILING[agent.name]
  if (!ceiling) return
  const denyAllIndex = agent.permission.findIndex(
    (rule) => rule.permission === "*" && rule.pattern === "*" && rule.action === "deny",
  )
  if (denyAllIndex === -1) return
  const kept: PermissionNext.Ruleset = []
  agent.permission.forEach((rule, index) => {
    if (index > denyAllIndex && rule.action === "allow" && !ceiling.has(rule.permission)) return
    kept.push(rule)
  })
  kept.push(...sensitiveReadDenies())
  agent.permission = kept
}
