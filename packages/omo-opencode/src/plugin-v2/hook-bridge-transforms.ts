import type { Hooks } from "@opencode-ai/plugin"
import type { SessionCompaction, SessionContext } from "@opencode/plugin/promise/session"
import { createMessagesView } from "./hook-bridge-messages"
import { userMessageInfo } from "./hook-bridge-message-info"
import { resolveHookModel } from "./hook-bridge-model"
import { applyChatParamsView, buildChatParamsView } from "./hook-bridge-params"
import type { NativeInstructions } from "./native-instructions"

type RequestContext = Parameters<typeof userMessageInfo>[0] & Pick<SessionContext, "system" | "messages" | "options" | "tools">

export async function applyContextHooks(ctx: Parameters<typeof resolveHookModel>[0], hooks: Hooks, event: RequestContext, instructions?: NativeInstructions): Promise<void> {
  const model = await resolveHookModel(ctx, event.model)
  const system = hooks["experimental.chat.system.transform"]
  if (system) {
    const output = { system: event.system.map((part) => part.text) }
    await system({ sessionID: event.sessionID, model: model.model }, output)
    const added = output.system.slice(event.system.length)
    if (instructions && added.length > 0) {
      const carried = new Set(added.filter((text) => event.system.some((part) => part.text.includes(text)) || event.messages.some((message) =>
        message.role === "system" && message.content.some((part) => part.type === "text" && part.text.includes(text)))))
      if (carried.size !== added.length) await instructions.put(event.sessionID, "omo-system-guidance", added.join("\n\n"))
      output.system = output.system.filter((text, index) => index < event.system.length || !carried.has(text))
    }
    event.system = output.system.map((text) => event.system.find((part) => part.text === text) ?? { type: "text", text })
  }
  const messages = hooks["experimental.chat.messages.transform"]
  if (messages) {
    const view = createMessagesView(event)
    await messages({}, view.output)
    event.messages = view.restore()
  }
  const parameters = hooks["chat.params"]
  if (parameters) {
    const view = buildChatParamsView(event.options)
    const message = userMessageInfo(event, event.messages.findLast((entry) => entry.role === "user")?.id ?? "")
    await parameters({ sessionID: event.sessionID, agent: event.agent, ...model, message }, view.output)
    applyChatParamsView(event.options, view)
  }
  const definition = hooks["tool.definition"]
  if (definition) for (const [toolID, tool] of Object.entries(event.tools)) {
    const output = { description: tool.description, parameters: tool.input }
    await definition({ toolID }, output)
    event.tools[toolID] = { description: output.description, input: output.parameters }
  }
}

export async function applyCompactionHook(hook: NonNullable<Hooks["experimental.session.compacting"]>, event: { readonly sessionID: string; system: SessionCompaction["system"] }): Promise<void> {
  const output: { context: string[]; prompt?: string } = { context: [] }
  await hook({ sessionID: event.sessionID }, output)
  if (output.prompt !== undefined) event.system = [{ type: "text", text: output.prompt }]
  event.system.push(...output.context.map((text) => ({ type: "text" as const, text })))
}
