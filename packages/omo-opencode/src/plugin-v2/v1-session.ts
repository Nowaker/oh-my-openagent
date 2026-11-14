import type { Todo } from "@opencode-ai/sdk"
import type { Plugin } from "@opencode/plugin"
import { guardV1Surface, unsupportedV1Call } from "./v1-client-errors"
import { projectV1Message, type V1MessageView } from "./v1-session-messages"
import { nativeTodos } from "./native-todos"
import { createDelegatedSession, type CreateInput } from "./v1-session-authority"
import { createPromptAdmission, type AdmissionReceipt, type PromptInput } from "./v1-session-prompt"
import type { DelegationOptions } from "./permission-actions"

type SessionPath = { readonly path: { readonly id: string } }
type StatusInput = { readonly query?: { readonly directory?: string } }
type V1SessionStatus = { readonly type: "busy" | "idle"; readonly updatedAt: number }

export type V1SessionContext = {
  readonly location: Pick<Plugin.Context["location"], "directory">
  readonly agent: Pick<Plugin.Context["agent"], "list">
  readonly session: Pick<Plugin.Context["session"], "get" | "list" | "create" | "context" | "switchAgent" | "switchModel" | "prompt" | "synthetic" | "update" | "instructions" | "wait" | "interrupt" | "remove">
}

export type V1Envelope<T> = { readonly data: T }
type ProjectedSession = Awaited<ReturnType<Plugin.Context["session"]["get"]>> & { readonly directory: string }
export type V1SessionAdapter = {
  readonly get: (input: SessionPath) => Promise<V1Envelope<ProjectedSession>>
  readonly list: (input?: { readonly query?: { readonly directory?: string } }) => Promise<V1Envelope<ProjectedSession[]>>
  readonly create: (input?: CreateInput) => Promise<V1Envelope<ProjectedSession>>
  readonly messages: (input: SessionPath & { readonly query?: { readonly limit?: number } }) => Promise<V1Envelope<V1MessageView[]>>
  readonly promptAsync: (input: PromptInput) => Promise<V1Envelope<AdmissionReceipt>>
  readonly prompt: (input: PromptInput) => Promise<V1Envelope<V1MessageView>>
  readonly abort: (input: SessionPath) => Promise<V1Envelope<Awaited<ReturnType<Plugin.Context["session"]["interrupt"]>>>>
  readonly delete: (input: SessionPath) => Promise<V1Envelope<boolean>>
  readonly status: (input?: StatusInput) => Promise<V1Envelope<Record<string, V1SessionStatus>>>
  readonly todo: (input: SessionPath) => Promise<V1Envelope<Todo[]>>
  readonly children: () => Promise<never>
}

export function createV1SessionAdapter(ctx: V1SessionContext, options: DelegationOptions = {}): V1SessionAdapter {
  const admit = createPromptAdmission(ctx, options)
  return guardV1Surface({
    get: async (input: SessionPath) => {
      const session = await ctx.session.get({ sessionID: input.path.id })
      return { data: { ...session, directory: session.location.directory } }
    },
    list: async (input?: { readonly query?: { readonly directory?: string } }) => {
      const result = await ctx.session.list({ directory: input?.query?.directory })
      return { data: result.data.map((session) => ({ ...session, directory: session.location.directory })) }
    },
    create: async (input?: CreateInput) => {
      const session = await createDelegatedSession(ctx, input, options)
      return { data: { ...session, directory: session.location.directory } }
    },
    messages: async (input: SessionPath & { readonly query?: { readonly limit?: number } }) => {
      const limit = input.query?.limit
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) return unsupportedV1Call("session.messages.limit")
      const messages = await ctx.session.context({ sessionID: input.path.id })
      const selected = limit === undefined ? messages : limit === 0 ? [] : messages.slice(-limit)
      return { data: selected.map((message) => projectV1Message(message, input.path.id)) }
    },
    promptAsync: async (input: PromptInput) => {
      const receipt = await admit(input, "session.promptAsync")
      return { data: receipt }
    },
    prompt: async (input: PromptInput) => {
      const receipt = await admit(input, "session.prompt")
      if (input.body?.noReply) {
        switch (receipt.type) {
          case "user": return { data: projectV1Message({ ...receipt.payload, id: receipt.id, time: receipt.time, type: "user" }, input.path.id) }
          case "synthetic": return { data: projectV1Message({ ...receipt.payload, id: receipt.id, time: receipt.time, type: "synthetic" }, input.path.id) }
        }
      }
      await ctx.session.wait({ sessionID: input.path.id })
      const messages = await ctx.session.context({ sessionID: input.path.id })
      const boundary = messages.findIndex((message) => message.id === receipt.id)
      const response = messages.slice(boundary + 1).findLast((message) => message.type === "assistant")
      if (boundary < 0 || !response) return unsupportedV1Call("session.prompt.response")
      return { data: projectV1Message(response, input.path.id) }
    },
    abort: async (input: SessionPath) => ({ data: await ctx.session.interrupt({ sessionID: input.path.id }) }),
    delete: async (input: SessionPath) => { await ctx.session.remove({ sessionID: input.path.id }); return { data: true } },
    status: async (input?: StatusInput) => {
      const entries: [string, V1SessionStatus][] = []
      let page = await ctx.session.list({ directory: input?.query?.directory ?? ctx.location.directory })
      for (;;) {
        for (const session of page.data) {
          const { busy, idle, updated } = session.time
          const active = busy !== undefined && (idle === undefined || busy > idle)
          entries.push([session.id, { type: active ? "busy" : "idle", updatedAt: updated }])
        }
        if (!page.cursor.next) break
        page = await ctx.session.list({ cursor: page.cursor.next })
      }
      return { data: Object.fromEntries(entries) }
    },
    todo: async (input: SessionPath) => ({ data: await nativeTodos(ctx.session, input.path.id) }),
    children: async () => unsupportedV1Call("session.children"),
  }, "session")
}
