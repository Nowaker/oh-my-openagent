import { partitionItems } from "../tools/delegate-task/fan-out"
import { createDelegateTaskPresentation } from "../tools/delegate-task/tool-description"
import { ALLOWED_AGENTS } from "../tools/call-omo-agent/constants"
import { getAgentConfigKey } from "../shared/agent-display-names"
import type { Managers } from "../create-managers"
import type { OhMyOpenCodeConfig } from "../config"
import type { createTools } from "../create-tools"
import { nativeTaskArguments, nativeCallArguments, nativeOutputArguments, nativeCancelArguments, nativeSubagentResult, type NativeNotice, type NativeTaskArguments, type NativeSubagentReceipt } from "./native-task-arguments"
import { buildNativeTaskPlan } from "./native-task-policy"
import { applyNativeTaskSettings, persistNativeTaskProgress } from "./native-task-progress"
import { nativeTaskOutput } from "./native-task-output"
import { nativeTaskCancel } from "./native-task-cancel"
import type { NativeTaskContext, NativeTaskDependencies, NativeTool, NativeToolContext, NativeToolResult, NativeRegistration, NativeTaskBindings, NativeTaskMetadata } from "./native-task-types"
import { NativeTaskCapabilityError, NativeTaskError, readNativeTaskMetadata } from "./native-task-types"

export type NativeTaskRuntime = {
  readonly overrides: readonly NativeTool[]
  readonly bindManagers: (config: OhMyOpenCodeConfig, managers: Managers) => Managers
  readonly bindTools: (tools: Awaited<ReturnType<typeof createTools>>) => Awaited<ReturnType<typeof createTools>>
  readonly install: () => Promise<void>
  readonly cleanup: () => Promise<void>
}
type NativeInvocationResult = NativeToolResult & { readonly output: NativeSubagentReceipt }

export function createNativeTaskRuntime(ctx: NativeTaskContext, dependencies: NativeTaskDependencies = {}): NativeTaskRuntime {
  let native: NativeTool | undefined
  let config: OhMyOpenCodeConfig | undefined
  let managers: Managers | undefined
  let tools: Awaited<ReturnType<typeof createTools>> | undefined
  let closed = false
  let installation: Promise<void> | undefined
  let cleanup: Promise<void> | undefined
  const registrations: NativeRegistration[] = []
  const bindings = (): NativeTaskBindings => {
    if (closed) throw new NativeTaskError("runtime-disposed", "Native task runtime has been disposed")
    if (!config || !managers || !tools) throw new NativeTaskError("unbound-policy", "Bind the real createManagers/createTools results before invoking native task tools")
    return { config: dependencies.getPluginConfig?.() ?? config, managers, tools }
  }
  const requireOptions = (feature: string): void => {
    if (ctx.app.capabilities?.subagentOptions !== true) throw new NativeTaskCapabilityError(`subagentOptions.${feature}`)
  }
  const launch = async (args: NativeTaskArguments, context: NativeToolContext, options: { readonly notice: NativeNotice; readonly authorize: (agent: string) => Promise<void>; readonly prepared?: Awaited<ReturnType<typeof buildNativeTaskPlan>> }): Promise<NativeInvocationResult> => {
    const { notice } = options
    const bound = bindings()
    if (!native) throw new NativeTaskCapabilityError("captured native subagent tool")
    const engine = native
    if (notice !== "each") requireOptions(typeof notice === "string" ? notice : "group")
    const fork = !args.category && args.subagent_type === "fork"
    if (fork) {
      requireOptions("fork")
      if (args.task_id) throw new NativeTaskError("fork-continuation", "fork is allowed only for a new child")
      if (ctx.app.capabilities?.sessionMessages !== true || !ctx.session.messages) throw new NativeTaskCapabilityError("sessionMessages for fork boundary")
    }
    const handoff = bound.config.background_task?.foregroundHandoffMs
    let previous: NativeTaskMetadata | undefined
    let previousSession
    if (args.task_id) {
      if (args.task_id.startsWith("bg_")) throw new NativeTaskError("resume-session-id-required", "Continuation requires the durable child session ID, not a background alias")
      previousSession = await ctx.session.get({ sessionID: args.task_id })
      previous = readNativeTaskMetadata(previousSession, context.sessionID)
    }
    const prepared = options.prepared ?? await buildNativeTaskPlan(ctx, { args, context, bindings: bound, previous, previousSession })
    if (!prepared.background && handoff !== undefined && handoff > 0) requireOptions("foregroundHandoffMs")
    await options.authorize(prepared.plan.agent)
    let progressedSessionID: string | undefined
    // Native packages/core/src/session/info.ts:30 maps absent variants to "default"; reverse that sentinel for subagent model refs.
    const variant = prepared.plan.model?.variant === "default" ? undefined : prepared.plan.model?.variant
    const result = await engine.execute({
      agent: prepared.plan.agent, description: prepared.description, prompt: prepared.prompt, background: prepared.background,
      ...(prepared.plan.model ? { model: `${prepared.plan.model.providerID}/${prepared.plan.model.modelID}${variant ? `#${variant}` : ""}` } : {}),
      ...(args.task_id ? { sessionID: args.task_id } : {}), ...(fork ? { fork: true } : {}),
      ...(notice === "each" ? {} : { notice }),
      ...(!prepared.background && handoff !== undefined && handoff > 0 ? { foregroundHandoffMs: handoff } : {}),
    }, {
      ...context,
      progress: async (update) => {
        if (typeof update.sessionID === "string") {
          await persistNativeTaskProgress(ctx, { sessionID: update.sessionID, context, bindings: bound, plan: prepared.plan,
            description: prepared.description, fork, previous })
          progressedSessionID = update.sessionID
        }
        await context.progress(update)
      },
    })
    const output = nativeSubagentResult.parse(result.output)
    if (progressedSessionID !== output.sessionID) throw new NativeTaskError("missing-native-progress", "Native subagent did not await matching durable child progress")
    if (args.task_id && output.sessionID !== args.task_id) throw new NativeTaskError("native-child-mismatch", "Native continuation returned a different child session")
    const header = `Background output/cancel alias: bg_${output.sessionID}\nContinuation session ID: ${output.sessionID}`
    return { ...result, output: { ...output, background_task_id: `bg_${output.sessionID}` },
      content: typeof result.content === "string" ? `${header}\n\n${result.content}` : [{ type: "text", text: header }, ...(result.content ?? [])],
      metadata: { ...result.metadata, sessionID: output.sessionID, backgroundTaskId: `bg_${output.sessionID}` } }
  }
  const task = async (raw: unknown, context: NativeToolContext, action: "task" | "call_omo_agent" = "task"): Promise<NativeToolResult> => {
    const args = nativeTaskArguments.parse(raw)
    let authorization: Promise<void> | undefined
    const authorize = (agent: string) => {
      authorization ??= ctx.permission.assert({ sessionID: context.sessionID, agent: context.agent,
        action, resources: [agent], save: [agent], source: { type: "tool", messageID: context.messageID, id: context.id } })
      return authorization
    }
    if (!args.items && args.split !== undefined) throw new NativeTaskError("split-without-items", "split requires items")
    if (!args.items) return launch(args, context, { notice: args.wake ?? "each", authorize })
    if (args.task_id) throw new NativeTaskError("fanout-continuation", "Fan-out cannot resume one durable session ID")
    const slices = partitionItems(args.items, args.split)
    const group = args.wake === undefined ? crypto.randomUUID() : undefined
    if (group) requireOptions("group")
    if (args.wake === "none") requireOptions("none")
    const prepared = await buildNativeTaskPlan(ctx, { args, context, bindings: bindings() })
    await authorize(prepared.plan.agent)
    let first = 1
    const children = slices.map((slice, index) => {
      const start = first
      first += slice.length
      const prompt = `${args.prompt}\n\nYour share of the work is items ${start}-${first - 1} of ${args.items?.length}. Handle only these:\n${slice.map((item) => `- ${item}`).join("\n")}`
      const description = `${prepared.description} [${index + 1}/${slices.length}]`
      return launch({ ...args, items: undefined, split: undefined, run_in_background: true, prompt, description }, context, {
        authorize,
        notice: group ? { group: { id: group, index, total: slices.length } } : args.wake ?? "each",
        prepared: { ...prepared, description, prompt: prepared.fork ? `${prepared.prompt}\n\n${prompt}` : prompt, background: true },
      })
    })
    const settled = await Promise.allSettled(children)
    const successes = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : [])
    const failures = settled.flatMap((result, index) => result.status === "rejected" ? [{ index, error: result.reason instanceof Error ? result.reason.message : "Native launch failed" }] : [])
    return { output: { children: successes.map((result) => result.output), failures },
      content: `Native fan-out: ${successes.length} admitted, ${failures.length} failed.\n${successes.map((result) => `- ${result.output.background_task_id}: ${result.output.sessionID}`).join("\n")}\n${failures.length ? JSON.stringify(failures) : "Native engine owns completion notices."}` }
  }
  const definitions: NativeTool[] = [
    { name: "task", input: nativeTaskArguments.toJSONSchema(), description: "Delegate through OMO category, agent and skill policy using the native subagent engine.", options: { codemode: false }, execute: task },
    { name: "call_omo_agent", input: nativeCallArguments.toJSONSchema(), description: "Call an allowed OMO explore or librarian agent through the native engine.", options: { codemode: false }, execute: async (raw, context) => {
      const args = nativeCallArguments.parse(raw)
      if (!ALLOWED_AGENTS.some((agent) => getAgentConfigKey(agent) === getAgentConfigKey(args.subagent_type))) throw new NativeTaskError("invalid-call-agent", "call_omo_agent accepts only its configured callable agent set")
      if (args.run_in_background && args.session_id) throw new NativeTaskError("call-background-continuation", "call_omo_agent session_id requires run_in_background:false")
      const { session_id, ...call } = args
      return task({ ...call, task_id: session_id, load_skills: [] }, context, "call_omo_agent")
    } },
    { name: "background_output", input: nativeOutputArguments.toJSONSchema(), description: "Read the task's durable native messages with native waiting and explicit ownership checks.", options: { codemode: false }, execute: (raw, context) => { bindings(); return nativeTaskOutput(ctx, dependencies, nativeOutputArguments.parse(raw), context) } },
    { name: "background_cancel", input: nativeCancelArguments.toJSONSchema(), description: "Cancel through the real native job owner, or stop a retained OMO monitor.", options: { codemode: false }, execute: (raw, context) => nativeTaskCancel(ctx, dependencies, bindings(), nativeCancelArguments.parse(raw), context) },
  ]
  const overrides = (): readonly NativeTool[] => {
    const currentConfig = dependencies.getPluginConfig?.() ?? config
    const enabled = definitions.filter((tool) => !currentConfig?.disabled_tools?.includes(tool.name))
      .map((tool) => ({ ...tool, output: { type: "object" as const } }))
    if (!currentConfig || !tools) return enabled
    const description = createDelegateTaskPresentation({ userCategories: currentConfig.categories, availableCategories: tools.availableCategories, availableSkills: tools.availableSkills }).description
    return enabled.map((tool) => tool.name === "task" ? { ...tool, description } : tool)
  }
  return {
    get overrides() { return overrides() },
    bindManagers: (nextConfig, nextManagers) => { config = nextConfig; managers = nextManagers; return nextManagers },
    bindTools: (nextTools) => { tools = nextTools; return nextTools },
    install: () => {
      if (closed) return Promise.reject(new NativeTaskError("runtime-disposed", "Native task runtime has been disposed"))
      installation ??= (async () => {
        registrations.push(await ctx.tool.transform((editor) => {
          const found = editor.get("subagent") ?? editor.list().find((tool) => tool.name === "subagent")
          if (!found) throw new NativeTaskCapabilityError("native subagent tool")
          native = found
          editor.remove(found.id)
          for (const override of overrides()) editor.add(override)
        }))
        registrations.push(await ctx.session.hook("context", (event) => applyNativeTaskSettings(ctx, event)))
      })()
      return installation
    },
    cleanup: () => {
      closed = true
      cleanup ??= (async () => {
        try { await installation } finally {
          const results = await Promise.allSettled(registrations.splice(0).map((registration) => registration.dispose()))
          native = undefined
          const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
          if (errors.length) throw new AggregateError(errors, "Native task runtime cleanup failed")
        }
      })()
      return cleanup
    },
  }
}
