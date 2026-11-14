import type { Plugin } from "@opencode/plugin"
import type { Info, ToolContext } from "@opencode/plugin/promise/tool"
import type { SessionContext } from "@opencode/plugin/promise/session"
import type { OhMyOpenCodeConfig } from "../config"
import type { Managers } from "../create-managers"
import type { createTools } from "../create-tools"
import type { DelegatedModelConfig } from "../shared/model-resolution-types"
import type { FallbackEntry } from "../shared/model-requirements"
import { z } from "zod"

export type NativeTool = Info
export type NativeToolContext = ToolContext
export type NativeToolResult = Awaited<ReturnType<NativeTool["execute"]>>
export type NativeMessage = Awaited<ReturnType<Plugin.Context["session"]["context"]>>[number]
export type NativeSession = Awaited<ReturnType<Plugin.Context["session"]["get"]>>
export type NativeMessagesInput = { readonly sessionID: string; readonly type?: NativeMessage["type"]; readonly order?: "asc" | "desc"; readonly limit?: number; readonly cursor?: string }
export type NativeMessagesPage = { readonly data: readonly NativeMessage[]; readonly cursor: { readonly previous?: string | null; readonly next?: string | null } }
export type NativeRegistration = { readonly dispose: () => Promise<void> }
export type NativeChildCancellation = { readonly status: "cancelled" } | { readonly status: "terminal"; readonly state: "completed" | "error" | "cancelled" } | { readonly status: "requested" } | { readonly status: "unsupported"; readonly reason: string }

export type NativeTaskContext = Pick<Plugin.Context, "tool" | "location"> & {
  readonly model: Pick<Plugin.Context["model"], "list" | "default">
  readonly agent: Pick<Plugin.Context["agent"], "list">
  readonly permission: Pick<Plugin.Context["permission"], "assert">
  readonly app: Plugin.Context["app"] & { readonly capabilities?: { readonly subagentOptions?: boolean; readonly sessionMessages?: boolean; readonly childCancellation?: boolean; readonly jobControl?: boolean; readonly jobResults?: boolean } }
  readonly session: Pick<Plugin.Context["session"], "get" | "list" | "update" | "context" | "interrupt" | "wait" | "instructions"> & {
    readonly messages?: (input: NativeMessagesInput) => Promise<NativeMessagesPage>
    readonly cancelChild?: (input: { readonly parentID: string; readonly sessionID: string }) => Promise<NativeChildCancellation>
    readonly hook: (name: "context", callback: (input: SessionContext) => Promise<void> | void) => Promise<NativeRegistration>
  }
}

export type NativeTaskBindings = {
  readonly config: OhMyOpenCodeConfig
  readonly managers: Managers
  readonly tools: Awaited<ReturnType<typeof createTools>>
}

export type NativeJobInfo = { readonly id: string; readonly sessionID: string; readonly kind: "shell" | "subagent" | "image"; readonly status: "running" | "completed" | "error" | "cancelled" }
export type NativeJobResult = NativeJobInfo & { readonly output?: string; readonly error?: string }

export type NativeTaskDependencies = {
  readonly getPluginConfig?: () => OhMyOpenCodeConfig
  readonly cancelJob?: (input: { readonly id: string; readonly parentSessionID: string; readonly signal: AbortSignal }) => Promise<NativeChildCancellation>
  readonly listJobs?: (parentSessionID: string, descendants?: true) => Promise<readonly NativeJobInfo[]>
  readonly resultJob?: (input: { readonly id: string; readonly parentSessionID: string; readonly wait: boolean; readonly signal: AbortSignal }) => Promise<NativeJobResult>
}

export type NativeTaskPlan = {
  readonly agent: string
  readonly model?: DelegatedModelConfig
  readonly system?: string
  readonly category?: string
  readonly categoryPromptAppend?: string
  readonly maxPromptTokens?: number
  readonly fallbackChain?: readonly FallbackEntry[]
  readonly skills: readonly string[]
}

export class NativeTaskError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = "NativeTaskError"
  }
}

export class NativeTaskCapabilityError extends NativeTaskError {
  constructor(readonly capability: string) {
    super("unsupported-capability", `Native task capability is unavailable: ${capability}`)
    this.name = "NativeTaskCapabilityError"
  }
}

export const nativeTaskMetadata = z.object({
  version: z.literal(1),
  parentSessionID: z.string(),
  agent: z.string(),
  description: z.string(),
  skills: z.array(z.string()),
  category: z.string().optional(),
  categoryPromptAppend: z.string().optional(),
  maxPromptTokens: z.number().optional(),
  fallbackChain: z.array(z.object({
    providers: z.array(z.string()), model: z.string(), variant: z.string().optional(), reasoning: z.string().optional(),
    reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
    temperature: z.number().optional(), top_p: z.number().optional(), maxTokens: z.number().optional(),
    thinking: z.object({ type: z.enum(["enabled", "disabled"]), budgetTokens: z.number().optional() }).optional(),
  })).optional(),
  ownMessagesSince: z.string().optional(),
  fork: z.boolean(),
  settings: z.object({
    reasoning: z.string().optional(), reasoningEffort: z.string().optional(), temperature: z.number().optional(), top_p: z.number().optional(), maxTokens: z.number().optional(),
    thinking: z.object({ type: z.enum(["enabled", "disabled"]), budgetTokens: z.number().optional() }).optional(),
  }).optional(),
})
export type NativeTaskMetadata = z.infer<typeof nativeTaskMetadata>
export const NATIVE_TASK_METADATA_KEY = "omoNativeTask"

export function readNativeTaskMetadata(session: NativeSession, parentSessionID: string): NativeTaskMetadata {
  if (session.parentID !== parentSessionID) throw new NativeTaskError("parent-mismatch", "Task session is not a direct child of the caller")
  const metadata = nativeTaskMetadata.safeParse(session.metadata?.[NATIVE_TASK_METADATA_KEY])
  if (!metadata.success || metadata.data.parentSessionID !== parentSessionID) throw new NativeTaskError("unowned-session", "Session has no matching durable OMO task ownership")
  return metadata.data
}
