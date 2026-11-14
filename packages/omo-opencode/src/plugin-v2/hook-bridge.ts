import type { Hooks } from "@opencode-ai/plugin"
import type { Plugin } from "@opencode/plugin"
import { log } from "../shared/logger"
import { applyChatMessageView, buildChatMessageView } from "./hook-bridge-chat"
import { subscribeV1Events } from "./hook-bridge-events"
import { resolveHookModel } from "./hook-bridge-model"
import { userMessageInfo } from "./hook-bridge-message-info"
import { bridgeToolHooks } from "./hook-bridge-tools"
import { applyCompactionHook, applyContextHooks } from "./hook-bridge-transforms"
import { UnsupportedHookMappingError, type Registration } from "./hook-bridge-types"
import type { NativeInstructions } from "./native-instructions"
import { resolveNativeSelection } from "./native-selection"

async function runHook(name: string, action: () => Promise<void>): Promise<void> {
  try { await action() }
  catch (error) {
    log("[v2-bridge] hook failed", { hook: name, errorName: error instanceof Error ? error.name : typeof error, ...(error instanceof UnsupportedHookMappingError ? { mapping: error.mapping } : {}) })
    throw error
  }
}

export async function bridgeHooks(ctx: Plugin.Context, hooks: Hooks, instructions?: NativeInstructions): Promise<() => Promise<void>> {
  const registrations: Registration[] = []
  let disposeEvents: (() => Promise<void>) | undefined
  const cleanup = async () => {
    const results = await Promise.allSettled([
      ...registrations.splice(0).reverse().map((entry) => entry.dispose()),
      ...(disposeEvents ? [disposeEvents()] : []),
    ])
    disposeEvents = undefined
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
    if (errors.length) {
      log("[v2-bridge] cleanup failed", { failures: errors.length })
      throw new AggregateError(errors, "V2 hook cleanup failed")
    }
  }
  try {
    const prompt = hooks["chat.message"]
    if (prompt) registrations.push(await ctx.session.hook("prompt", (event) => runHook("chat.message", async () => {
       const identity = await resolveNativeSelection(ctx, event.sessionID)
      const view = buildChatMessageView(event, identity)
      await prompt(view.input, view.output)
      applyChatMessageView(event, view.output)
    })))
    if (hooks["experimental.chat.system.transform"] || hooks["experimental.chat.messages.transform"] || hooks["chat.params"] || hooks["tool.definition"]) {
      registrations.push(await ctx.session.hook("context", (event) => runHook("context", () => applyContextHooks(ctx, hooks, event, instructions))))
      log("[v2-bridge] request projection gaps", { mappings: ["v1.message.persistence-fields", "v1.model.reasoning-capability-and-provider-origin", "messages.media-and-native-parts-opaque"] })
    }
    const headers = hooks["chat.headers"]
    if (headers) registrations.push(await ctx.session.hook("model.request", (event) => runHook("chat.headers", async () => {
      const model = await resolveHookModel(ctx, event.model)
      const native = await ctx.session.context({ sessionID: event.sessionID })
      const latest = native.findLast((entry) => entry.type === "user" || entry.type === "synthetic")
      const message = userMessageInfo(event, latest?.id ?? "")
      const output = { headers: { ...event.headers } }
      await headers({ sessionID: event.sessionID, agent: event.agent, ...model, message }, output)
      event.headers = output.headers
    })))
    const compaction = hooks["experimental.session.compacting"]
    if (compaction) registrations.push(await ctx.session.hook("compaction", (event) => runHook("experimental.session.compacting", () => applyCompactionHook(compaction, event))))
    await bridgeToolHooks(ctx, hooks, registrations)
    if (hooks.event) disposeEvents = subscribeV1Events(ctx, hooks.event)
    for (const mapping of ["command.execute.before", "experimental.compaction.autocontinue", "permission.ask", "experimental.text.complete", "experimental.provider.small_model"] as const) {
      if (hooks[mapping]) log("[v2-bridge] unsupported mapping", { mapping })
    }
    log("[v2-bridge] hooks registered", { registrations: registrations.length })
    return cleanup
  } catch (error) {
    await cleanup()
    log("[v2-bridge] registration failed", { errorName: error instanceof Error ? error.name : typeof error })
    throw error
  }
}
