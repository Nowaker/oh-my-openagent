import type { Event, Session } from "@opencode-ai/sdk"
import type { Hooks } from "@opencode-ai/plugin"
import { log } from "../shared/logger"
import { assistantMessageInfo } from "./hook-bridge-message-info"
import type { BridgeContext, NativeEvent } from "./hook-bridge-types"

type EventContext = { readonly session: Pick<BridgeContext["session"], "context">; readonly location: Pick<BridgeContext["location"], "directory"> }

export async function buildV1EventView(ctx: EventContext, event: NativeEvent, sessions: Map<string, Session>): Promise<Event | undefined> {
  switch (event.type) {
    case "session.created": {
      const data = event.data
      const info: Session = {
        id: data.sessionID, projectID: data.projectID, directory: data.location.directory,
        parentID: data.parentID, title: data.title ?? "", version: data.version,
        time: { created: event.created, updated: event.created },
      }
      sessions.set(info.id, info)
      return { type: "session.created", properties: { info } }
    }
    case "session.deleted": {
      const info = sessions.get(event.data.sessionID)
      sessions.delete(event.data.sessionID)
      if (info) return { type: "session.deleted", properties: { info } }
      log("[v2-bridge] unsupported mapping", { mapping: "session.deleted.uncached-info", sessionID: event.data.sessionID })
      return undefined
    }
    case "session.status": return { type: "session.status", properties: { sessionID: event.data.sessionID, status: event.data.status } }
    case "session.idle": return { type: "session.idle", properties: { sessionID: event.data.sessionID } }
    case "session.execution.failed": return {
      type: "session.error", properties: { sessionID: event.data.sessionID, error: { name: "UnknownError", data: { ...event.data.error } } },
    }
    case "session.compaction.ended": return { type: "session.compacted", properties: { sessionID: event.data.sessionID } }
    case "session.text.ended": return { type: "message.part.updated", properties: { part: {
      id: `${event.data.assistantMessageID}:${event.data.ordinal}`, sessionID: event.data.sessionID, messageID: event.data.assistantMessageID,
      type: "text", text: event.data.text, metadata: { native: event.data.native },
    } } }
    case "session.reasoning.ended": return { type: "message.part.updated", properties: { part: {
      id: `${event.data.assistantMessageID}:${event.data.ordinal}`, sessionID: event.data.sessionID, messageID: event.data.assistantMessageID,
      type: "reasoning", text: event.data.text, metadata: { native: event.data.native }, time: { start: 0, end: event.created },
    } } }
    case "session.step.ended": {
      const messages = await ctx.session.context({ sessionID: event.data.sessionID })
      const native = messages.find((entry) => entry.id === event.data.assistantMessageID)
      if (native?.type !== "assistant") return undefined
      const info = assistantMessageInfo({ sessionID: event.data.sessionID, agent: native.agent, model: native.model }, native.id)
      return { type: "message.updated", properties: { info: {
        ...info, time: native.time, finish: native.finish, cost: native.cost ?? 0,
        tokens: native.tokens ?? info.tokens, path: { cwd: ctx.location.directory, root: ctx.location.directory },
      } } }
    }
    default: return undefined
  }
}

export function subscribeV1Events(ctx: EventContext & Pick<BridgeContext, "event">, handler: NonNullable<Hooks["event"]>) {
  const abort = new AbortController()
  const sessions = new Map<string, Session>()
  const unmapped = new Set<string>()
  let failure: unknown
  const loop = (async () => {
    for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
      try {
        const translated = await buildV1EventView(ctx, event, sessions)
        if (translated) await handler({ event: translated })
        else if (!unmapped.has(event.type)) {
          unmapped.add(event.type)
          log("[v2-bridge] unsupported event mapping", { type: event.type })
        }
      } catch (error) {
        log("[v2-bridge] event handler failed", { type: event.type, errorName: error instanceof Error ? error.name : typeof error })
      }
    }
  })().catch((error: unknown) => {
    if (abort.signal.aborted) return
    failure = error
    log("[v2-bridge] event subscription failed", { errorName: error instanceof Error ? error.name : typeof error })
  })
  return async () => {
    abort.abort()
    await loop
    sessions.clear()
    if (failure !== undefined) throw failure
  }
}
