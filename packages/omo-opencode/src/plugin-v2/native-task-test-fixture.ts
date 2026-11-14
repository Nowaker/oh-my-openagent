import { Agent, Location, Model } from "@opencode/plugin"
import { CallID, type ToolEditor } from "@opencode/plugin/promise/tool"
import { z } from "zod"
import { createManagers } from "../create-managers"
import { createHostDelegationFixture } from "../testing/host-delegation-test-fixture"
import { createNativeTaskRuntime, type NativeTaskRuntime } from "./native-task-runtime"
import type { NativeMessage, NativeSession, NativeTaskContext, NativeTaskDependencies, NativeTool, NativeToolContext, NativeToolResult, NativeTaskBindings } from "./native-task-types"
import { NATIVE_TASK_METADATA_KEY } from "./native-task-types"

const nativeInput = z.object({ agent: z.string(), description: z.string(), prompt: z.string(), model: z.string().optional(), sessionID: z.string().optional(), background: z.boolean().optional(),
  fork: z.boolean().optional(), notice: z.union([z.enum(["each", "none"]), z.object({ group: z.object({ id: z.string(), index: z.number(), total: z.number() }) })]).optional(), foregroundHandoffMs: z.number().optional() })

export type NativeTaskFixture = {
  readonly ctx: NativeTaskContext
  readonly context: NativeToolContext
  readonly runtime: NativeTaskRuntime
  readonly tools: Map<string, NativeTool & { readonly id: string }>
  readonly sessions: Map<string, NativeSession>
  readonly messages: Map<string, NativeMessage[]>
  readonly instructions: Map<string, string>
  readonly trace: string[]
  readonly assertions: Parameters<NativeTaskContext["permission"]["assert"]>[0][]
  readonly launches: z.infer<typeof nativeInput>[]
  readonly disposals: string[]
  readonly bindings: NativeTaskBindings
  readonly call: (name: string, args: unknown) => Promise<NativeToolResult>
  readonly applyContext: (event: Parameters<Parameters<NativeTaskContext["session"]["hook"]>[1]>[0]) => Promise<void>
  readonly close: () => Promise<void>
}

export async function createNativeTaskFixture(options: {
  readonly capabilities?: NativeTaskContext["app"]["capabilities"]
  readonly dependencies?: NativeTaskDependencies
  readonly foregroundHandoffMs?: number
  readonly status?: "running" | "completed"
  readonly childPermissions?: NativeSession["permissions"]
  readonly beforeNativeResult?: () => Promise<void>
} = {}): Promise<NativeTaskFixture> {
  const host = createHostDelegationFixture()
  const managers = createManagers({ ...host.args, delegationOwner: "host" })
  const location = new Location.Info({ directory: Location.Info.fields.directory.make(host.ctx.directory), project: {
    id: Location.Info.fields.project.fields.id.make("native-task"), directory: Location.Info.fields.project.fields.directory.make(host.ctx.directory), canonical: Location.Info.fields.project.fields.canonical.make(host.ctx.directory),
  } })
  const parent: NativeSession = { id: "ses_parent", projectID: "project", agent: "worker", model: { id: "chat", providerID: "provider" }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 }, location: { directory: host.ctx.directory } }
  const sessions = new Map<string, NativeSession>([[parent.id, parent]])
  const messages = new Map<string, NativeMessage[]>([[parent.id, [{ id: "msg_inherited", type: "user", text: "parent context", time: { created: 1 } }]]])
  const instructions = new Map<string, string>()
  const trace: string[] = []
  const assertions: Parameters<NativeTaskContext["permission"]["assert"]>[0][] = []
  const launches: z.infer<typeof nativeInput>[] = []
  const disposals: string[] = []
  const tools = new Map<string, NativeTool & { readonly id: string }>()
  const transforms = new Set<(editor: ToolEditor) => void>()
  const contextHooks = new Set<Parameters<NativeTaskContext["session"]["hook"]>[1]>()
  let childCount = 0
  const native: NativeTool = {
    name: "subagent", description: "Native implementation boundary", input: nativeInput.toJSONSchema(),
    execute: async (raw, context) => {
      const input = nativeInput.parse(raw)
      launches.push(input)
      const id = input.sessionID ?? `ses_child_${++childCount}`
      if (!sessions.has(id)) {
        sessions.set(id, { ...parent, id, parentID: context.sessionID, agent: input.agent, outcome: undefined, metadata: { engine: "retained" }, permissions: options.childPermissions ?? parent.permissions })
        messages.set(id, input.fork ? [...messages.get(context.sessionID) ?? []] : [])
      } else {
        const existing = sessions.get(id)
        if (!existing) throw new Error("Missing existing native child")
        sessions.set(id, { ...existing, agent: input.agent, outcome: undefined, ...(input.model ? { model: Model.Ref.parse(input.model) } : {}) })
      }
      trace.push(`native.created:${id}`)
      await context.progress({ sessionID: id, status: "running" })
      trace.push(`native.admitted:${id}`)
      if (!sessions.get(id)?.metadata?.[NATIVE_TASK_METADATA_KEY]) throw new Error("Native admission did not receive durable OMO metadata")
      const content = messages.get(id)
      if (!content) throw new Error("Missing native message store")
      content.push({ id: `msg_user_${launches.length}`, type: "user", text: input.prompt, time: { created: 2 } })
      if (options.beforeNativeResult) await options.beforeNativeResult()
      const status = options.status ?? (input.background ? "running" : "completed")
      if (status === "completed") {
        content.push({ id: `msg_answer_${launches.length}`, type: "assistant", agent: input.agent, model: { id: "chat", providerID: "provider" }, time: { created: 3, completed: 4 }, finish: "stop", content: [{ type: "text", text: `native answer ${id}` }] })
        const child = sessions.get(id)
        if (child) sessions.set(id, { ...child, outcome: "succeeded" })
      }
      return { output: { sessionID: id, status, output: status === "completed" ? `native answer ${id}` : "native admission" }, content: `Native ${status}` }
    },
  }
  tools.set("subagent", { ...native, id: "subagent" })
  const rebuild = () => {
    tools.clear()
    tools.set("subagent", { ...native, id: "subagent" })
    const editor: ToolEditor = { list: () => [...tools.values()], get: (id) => tools.get(id), namespace: () => { throw new Error("Unexpected namespace mutation") },
      add: (tool) => { tools.set(tool.name, { ...tool, id: tool.name }) }, remove: (id) => { tools.delete(id) },
      update: (id, update) => { const current = tools.get(id); if (current) { const next = { ...current }; update(next); tools.set(id, next) } },
    }
    for (const transform of transforms) transform(editor)
  }
  const ctx: NativeTaskContext = {
    app: { name: "fixture", version: "ignored", channel: "fixture", capabilities: options.capabilities ?? { subagentOptions: true, sessionMessages: true, childCancellation: true } }, location,
    tool: {
      list: async () => [...tools.values()], reload: async () => { rebuild() }, hook: async () => ({ dispose: async () => {} }),
      transform: async (callback) => {
        transforms.add(callback)
        rebuild()
        return { dispose: async () => { disposals.push("tools"); transforms.delete(callback); rebuild() } }
      },
    },
    permission: { assert: async (input) => { assertions.push(input) } },
    agent: { list: async () => ({ location, data: ["worker", "explore", "librarian", "sisyphus-junior"].map((id) => ({ id, name: id, mode: "subagent", hidden: false, permissions: [], request: { settings: {}, headers: {}, body: {} }, model: { id: "chat", providerID: "provider" } })) }) },
    model: { list: async () => ({ location, data: [{ id: "chat", modelID: "chat", providerID: "provider", name: "Chat", capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [{ id: "high", name: "High", settings: {} }], cost: [], time: { released: 1 }, status: "active", enabled: true, limit: { context: 100000, output: 4000 } }] }), default: async () => ({ location, data: null }) },
    session: {
      get: async ({ sessionID }) => { const value = sessions.get(sessionID); if (!value) throw new Error(`Missing session ${sessionID}`); return value },
      list: async () => ({ data: [...sessions.values()], cursor: {} }),
      update: async ({ sessionID, metadata, permissions }) => { const child = sessions.get(sessionID); if (!child) throw new Error("Missing child"); trace.push(`durable.write:${sessionID}`); sessions.set(sessionID, { ...child, ...(metadata ? { metadata } : {}), ...(permissions ? { permissions: [...permissions] } : {}) }) },
      context: async ({ sessionID }) => messages.get(sessionID) ?? [],
      messages: async ({ sessionID, order }) => { const data = [...messages.get(sessionID) ?? []]; return { data: order === "desc" ? data.reverse() : data, cursor: {} } },
      wait: async () => { trace.push("native.wait") }, interrupt: async () => ({ interrupted: false }),
      cancelChild: async ({ parentID, sessionID }) => {
        const child = sessions.get(sessionID)
        if (!child || child.parentID !== parentID) throw new Error("Native parent mismatch")
        if (child.outcome) return { status: "terminal", state: child.outcome === "succeeded" ? "completed" : child.outcome === "failed" ? "error" : "cancelled" }
        trace.push(`native.cancelled:${sessionID}`)
        sessions.set(sessionID, { ...child, outcome: "interrupted" })
        return { status: "cancelled" }
      },
      hook: async (_name, callback) => { contextHooks.add(callback); return { dispose: async () => { contextHooks.delete(callback); disposals.push("context") } } },
      instructions: { entry: { list: async () => [], put: async ({ sessionID, value }) => { if (typeof value !== "string") throw new Error("Expected instructions"); instructions.set(sessionID, value); trace.push(`instructions.write:${sessionID}`) }, remove: async ({ sessionID }) => { instructions.delete(sessionID) } } },
    },
  }
  const context: NativeToolContext = {
    sessionID: z.custom<NativeToolContext["sessionID"]>((value) => typeof value === "string" && value.startsWith("ses_")).parse(parent.id),
    messageID: z.custom<NativeToolContext["messageID"]>((value) => typeof value === "string" && value.startsWith("msg_")).parse("msg_parent"),
    agent: Agent.ID.make("worker"), id: CallID.make("call_parent"), signal: new AbortController().signal,
    progress: async () => { trace.push("host.progress") },
  }
  const runtime = createNativeTaskRuntime(ctx, options.dependencies)
  const bindings: NativeTaskBindings = {
    config: { ...host.args.pluginConfig, ...(options.foregroundHandoffMs === undefined ? {} : { background_task: { foregroundHandoffMs: options.foregroundHandoffMs } }), categories: { fixture: { model: "provider/chat", variant: "high", prompt_append: "category-specific input", temperature: 0.2 } } },
    managers, tools: { filteredTools: {}, mergedSkills: [], availableSkills: [], availableCategories: [], browserProvider: "playwright", disabledSkills: new Set(), taskSystemEnabled: false },
  }
  runtime.bindManagers(bindings.config, managers)
  runtime.bindTools(bindings.tools)
  await runtime.install()
  return { ctx, context, runtime, tools, sessions, messages, instructions, trace, assertions, launches, disposals, bindings,
    call: async (name, args) => {
      const tool = tools.get(name)
      if (!tool) throw new Error(`Missing registered native tool ${name}`)
      const result = await tool.execute(args, context)
      if (result.output !== undefined && tool.output === undefined) throw new Error("Tool result declared output without an output schema")
      return result
    },
    applyContext: async (event) => { for (const hook of contextHooks) await hook(event) },
    close: async () => { await runtime.cleanup(); await managers.shutdown?.(); await managers.skillMcpManager.disconnectAll() } }
}
