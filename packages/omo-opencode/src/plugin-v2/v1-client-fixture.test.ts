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
  readonly authority: string[]
} {
  const admitted: Parameters<Plugin.Context["session"]["prompt"]>[0][] = []
  const authority: string[] = []
  const ctx: V1ClientContext & Pick<Plugin.Context, "location"> = {
    app: { name: "opencode", version: "2.2.7", channel: "stable" }, location,
    session: {
      get: async () => sessionInfo,
      list: async () => ({ data: [sessionInfo], cursor: {} }),
      create: async (input) => ({ ...sessionInfo, parentID: input?.parentID ?? undefined, title: input?.title ?? undefined, location: input?.location ?? sessionInfo.location }),
      context: async () => [userMessage, assistantMessage],
      switchAgent: async (input) => { authority.push(`agent:${input.agent}`) },
      switchModel: async (input) => { authority.push(`model:${input.model.providerID}/${input.model.id}:${input.model.variant}`) },
      prompt: async (input) => {
        admitted.push(input)
        authority.push(`prompt:${input.text}`)
        return { id: input.id ?? "msg-user", sessionID: input.sessionID, type: "user", time: { created: 10 }, delivery: input.delivery ?? "queue", payload: { text: input.text } }
      },
      wait: async () => {},
      interrupt: async () => ({ interrupted: true }),
      remove: async () => {},
    },
    agent: { list: async () => ({ location, data: [] }) },
    model: { list: async () => ({ location, data: [] }), default: async () => ({ location, data: null }) },
    provider: { list: async () => ({ location, data: [] }) },
  }
  return { ctx, admitted, authority }
}
