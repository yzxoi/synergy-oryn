import type { Tool } from "@/tool/tool"
import type { ToolExecutorKind, ToolTaskResource } from "./tool-scheduler"

const processTools = new Set(["bash", "oryn_check"])
const fileTools = new Set([
  "read",
  "view_file",
  "view_image",
  "write",
  "edit",
  "save_file",
  "revise_file",
  "resolve_conflicts",
  "grep",
  "glob",
  "file_search",
  "ls",
  "scan_files",
  "scan_document",
  "parse_code",
  "ast_grep",
  "lsp",
])

export namespace ToolExecutor {
  export interface AdmissionInput {
    toolName: string
    executor: ToolExecutorKind
    sessionID: string
    input: unknown
    signal: AbortSignal
  }
  export interface Admission {
    executor: ToolExecutorKind
    resources?: readonly ToolTaskResource[]
  }
  const admissionProviders = new Map<string, (input: AdmissionInput) => Promise<Admission>>()

  export function registerAdmissionProvider(toolName: string, provider: (input: AdmissionInput) => Promise<Admission>) {
    if (admissionProviders.has(toolName)) throw new Error(`Admission provider already registered for ${toolName}`)
    admissionProviders.set(toolName, provider)
    return () => {
      if (admissionProviders.get(toolName) === provider) admissionProviders.delete(toolName)
    }
  }

  export async function admission(input: AdmissionInput): Promise<Admission> {
    input.signal.throwIfAborted()
    const provider = admissionProviders.get(input.toolName)
    if (!provider || input.executor !== classify(input.toolName)) return { executor: input.executor }
    const result = await provider(input)
    input.signal.throwIfAborted()
    return result
  }

  export function classify(toolName: string, source?: Tool.Source): ToolExecutorKind {
    if (source?.type === "plugin" || source?.type === "local" || toolName.startsWith("plugin__")) return "plugin"
    if (toolName.startsWith("browser_")) return "browser"
    if (toolName.startsWith("link_") || toolName.startsWith("remote_")) return "link"
    if (processTools.has(toolName)) return "local_process"
    if (fileTools.has(toolName)) return "file"
    return "control_plane"
  }
}
