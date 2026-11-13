import { Location, type Plugin } from "@opencode/plugin"
import type { V1ClientContext } from "./v1-client"
import type { V2SessionMessage } from "./v1-session-messages"

export const location: Plugin.Context["location"] = new Location.Info({
  directory: Location.Info.fields.directory.make("/scratch/project/worktree"),
  project: {
    id: Location.Info.fields.project.fields.id.make("project-1"),
    directory: Location.Info.fields.project.fields.directory.make("/scratch/project"),
    canonical: Location.Info.fields.project.fields.canonical.make("/scratch/project"),
  },
})

export const userMessage: Extract<V2SessionMessage, { readonly type: "user" }> = {
  id: "msg-user", type: "user", time: { created: 10 }, text: "request",
}

export const assistantMessage: Extract<V2SessionMessage, { readonly type: "assistant" }> = {
  id: "msg-assistant", type: "assistant", time: { created: 11, completed: 12 },
  agent: "Sisyphus", model: { id: "model", providerID: "provider" }, finish: "stop",
  native: { replay: "provider data" },
  content: [
    { type: "reasoning", text: "reason", native: { signature: "reason-signature" } },
    { type: "tool", id: "call-1", name: "read", time: { created: 11 }, native: { call: "provider-call" }, state: {
      status: "completed", input: { file: "code.ts" }, content: [{ type: "text", text: "tool result" }], metadata: { title: "read file" },
    } },
    { type: "text", text: "answer", native: { replay: "text" } },
  ],
}

export const sessionInfo: Awaited<ReturnType<Plugin.Context["session"]["get"]>> = {
  id: "session-1", parentID: "parent", projectID: "project-1", agent: "Sisyphus",
  model: { id: "model", providerID: "provider" }, title: "Session", cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 }, location: { directory: "/scratch/project/worktree" },
}

export function createClientFixture(): {
  readonly ctx: V1ClientContext & Pick<Plugin.Context, "location">
  readonly admitted: Parameters<Plugin.Context["session"]["prompt"]>[0][]
  readonly synthetic: Parameters<Plugin.Context["session"]["synthetic"]>[0][]
  readonly authority: string[]
  readonly sessions: Map<string, typeof sessionInfo>
  readonly instructions: Map<string, Map<string, Parameters<Plugin.Context["session"]["instructions"]["entry"]["put"]>[0]["value"]>>
  readonly messages: Map<string, V2SessionMessage[]>
} {
  const admitted: Parameters<Plugin.Context["session"]["prompt"]>[0][] = []
  const synthetic: Parameters<Plugin.Context["session"]["synthetic"]>[0][] = []
  const authority: string[] = []
  const sessions = new Map([[sessionInfo.id, structuredClone(sessionInfo)]])
  const instructions = new Map<string, Map<string, Parameters<Plugin.Context["session"]["instructions"]["entry"]["put"]>[0]["value"]>>()
  const messages = new Map<string, V2SessionMessage[]>([[sessionInfo.id, [userMessage, assistantMessage]]])
  const getSession = (id: string) => {
    const session = sessions.get(id)
    if (!session) throw new Error(`No native session ${id}`)
    return structuredClone(session)
  }
  const ctx: V1ClientContext & Pick<Plugin.Context, "location"> = {
    app: { name: "opencode", version: "2.2.7", channel: "stable" }, location,
    session: {
      get: async (input) => getSession(input.sessionID),
      list: async () => ({ data: [...sessions.values()], cursor: {} }),
      create: async (input) => {
        const session = { ...sessionInfo, id: input?.id ?? `session-${sessions.size + 1}`, parentID: input?.parentID ?? undefined, title: input?.title ?? undefined, location: input?.location ?? sessionInfo.location,
          agent: input?.agent ?? sessionInfo.agent, model: input?.model ?? sessionInfo.model, permissions: input?.permissions?.map((rule) => ({ ...rule })) }
        sessions.set(session.id, session)
        messages.set(session.id, [])
        return structuredClone(session)
      },
      context: async (input) => [...(messages.get(input.sessionID) ?? [])],
      update: async (input) => {
        const session = getSession(input.sessionID)
        sessions.set(input.sessionID, { ...session, ...(input.permissions === undefined ? {} : { permissions: input.permissions.map((rule) => ({ ...rule })) }) })
        authority.push("permissions")
      },
      instructions: { entry: {
        list: async (input) => [...(instructions.get(input.sessionID) ?? [])].map(([key, value]) => ({ key, value })),
        put: async (input) => {
          const entries = instructions.get(input.sessionID) ?? new Map()
          entries.set(input.key, input.value)
          instructions.set(input.sessionID, entries)
          authority.push(`instructions:${input.key}`)
        },
        remove: async (input) => { instructions.get(input.sessionID)?.delete(input.key) },
      } },
      switchAgent: async (input) => { sessions.set(input.sessionID, { ...getSession(input.sessionID), agent: input.agent }); authority.push(`agent:${input.agent}`) },
      switchModel: async (input) => { sessions.set(input.sessionID, { ...getSession(input.sessionID), model: { ...input.model } }); authority.push(`model:${input.model.providerID}/${input.model.id}:${input.model.variant}`) },
      prompt: async (input) => {
        admitted.push(input)
        authority.push(`prompt:${input.text}`)
        const receipt = { id: input.id ?? "msg-user", sessionID: input.sessionID, type: "user" as const, time: { created: 10 }, delivery: input.delivery ?? "queue", payload: { text: input.text } }
        messages.set(input.sessionID, [...(messages.get(input.sessionID) ?? []).filter((entry) => entry.id !== receipt.id), { ...receipt.payload, id: receipt.id, type: "user", time: receipt.time }])
        return receipt
      },
      synthetic: async (input) => {
        synthetic.push(input)
        authority.push(`synthetic:${input.text}`)
        const receipt = { id: input.id ?? "msg-synthetic", sessionID: input.sessionID, type: "synthetic" as const, time: { created: 10 }, delivery: input.delivery ?? "queue", payload: { text: input.text, description: input.description ?? undefined, metadata: input.metadata } }
        messages.set(input.sessionID, [...(messages.get(input.sessionID) ?? []), { ...receipt.payload, id: receipt.id, type: "synthetic", time: receipt.time }])
        return receipt
      },
      wait: async (input) => { messages.set(input.sessionID, [...(messages.get(input.sessionID) ?? []).filter((entry) => entry.id !== assistantMessage.id), assistantMessage]) },
      interrupt: async () => ({ interrupted: true }),
      remove: async () => {},
    },
    agent: { list: async () => ({ location, data: [] }) },
    model: { list: async () => ({ location, data: [] }), default: async () => ({ location, data: null }) },
    provider: { list: async () => ({ location, data: [] }) },
  }
  return { ctx, admitted, synthetic, authority, sessions, instructions, messages }
}
