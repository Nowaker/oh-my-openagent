import type { SessionPromptData, Todo } from "@opencode-ai/sdk"
import type { Plugin } from "@opencode/plugin"
import { guardV1Surface, unsupportedV1Call } from "./v1-client-errors"
import { projectV1Message, type V1MessageView } from "./v1-session-messages"
import { nativeTodos } from "./native-todos"

type SessionPath = { readonly path: { readonly id: string } }
type PromptBody = NonNullable<SessionPromptData["body"]> & { readonly variant?: string }
type PromptInput = SessionPath & { readonly body?: PromptBody }
type CreateInput = {
  readonly body?: {
    readonly parentID?: string
    readonly title?: string
    readonly agent?: string
    readonly model?: { readonly providerID: string; readonly modelID: string }
    readonly permission?: readonly { readonly permission: string; readonly pattern: string; readonly action: "allow" | "deny" | "ask" }[]
  }
  readonly query?: { readonly directory?: string }
}

export type V1SessionContext = {
  readonly location: Pick<Plugin.Context["location"], "directory">
  readonly session: Pick<Plugin.Context["session"], "get" | "list" | "create" | "context" | "switchAgent" | "switchModel" | "prompt" | "wait" | "interrupt" | "remove">
}

export type V1Envelope<T> = { readonly data: T }
type ProjectedSession = Awaited<ReturnType<Plugin.Context["session"]["get"]>> & { readonly directory: string }
export type V1SessionAdapter = {
  readonly get: (input: SessionPath) => Promise<V1Envelope<ProjectedSession>>
  readonly list: (input?: { readonly query?: { readonly directory?: string } }) => Promise<V1Envelope<ProjectedSession[]>>
  readonly create: (input?: CreateInput) => Promise<V1Envelope<ProjectedSession>>
  readonly messages: (input: SessionPath & { readonly query?: { readonly limit?: number } }) => Promise<V1Envelope<V1MessageView[]>>
  readonly promptAsync: (input: PromptInput) => Promise<V1Envelope<Awaited<ReturnType<Plugin.Context["session"]["prompt"]>>>>
  readonly prompt: (input: PromptInput) => Promise<V1Envelope<V1MessageView>>
  readonly abort: (input: SessionPath) => Promise<V1Envelope<Awaited<ReturnType<Plugin.Context["session"]["interrupt"]>>>>
  readonly delete: (input: SessionPath) => Promise<V1Envelope<boolean>>
  readonly status: () => Promise<never>
  readonly todo: (input: SessionPath) => Promise<V1Envelope<Todo[]>>
  readonly children: () => Promise<never>
}

function promptPayload(input: PromptInput, method: string): Parameters<Plugin.Context["session"]["prompt"]>[0] {
  const body = input.body
  if (!body) return unsupportedV1Call(`${method}.body`)
  if (body.system !== undefined) return unsupportedV1Call(`${method}.system`)
  if (body.tools !== undefined) return unsupportedV1Call(`${method}.tools`)
  if (body.variant !== undefined && body.model === undefined) return unsupportedV1Call(`${method}.variant`)
  const text: string[] = []
  const files: NonNullable<Parameters<Plugin.Context["session"]["prompt"]>[0]["files"]>[number][] = []
  const agents: NonNullable<Parameters<Plugin.Context["session"]["prompt"]>[0]["agents"]>[number][] = []
  for (const part of body.parts) {
    switch (part.type) {
      case "text":
        if (part.ignored || part.synthetic || part.metadata !== undefined || part.time !== undefined) return unsupportedV1Call(`${method}.parts.text`)
        text.push(part.text)
        break
      case "file":
        if (part.source !== undefined) return unsupportedV1Call(`${method}.parts.file.source`)
        files.push({ uri: part.url, name: part.filename })
        break
      case "agent":
        agents.push({ name: part.name, ...(part.source ? { mention: { start: part.source.start, end: part.source.end, text: part.source.value } } : {}) })
        break
      case "subtask":
        return unsupportedV1Call(`${method}.parts.subtask`)
      default:
        return assertExhaustive(part)
    }
  }
  return { sessionID: input.path.id, id: body.messageID, text: text.join("\n\n"), files, agents, resume: !body.noReply }
}

function assertExhaustive(value: never): never {
  throw new TypeError("Unrecognized v1 prompt part")
}

export function createV1SessionAdapter(ctx: V1SessionContext): V1SessionAdapter {
  const admissions = new Map<string, Promise<void>>()
  const admit = async (input: PromptInput, method: string) => {
    const payload = promptPayload(input, method)
    const previous = admissions.get(input.path.id) ?? Promise.resolve()
    const operation = previous.then(async () => {
      if (input.body?.agent !== undefined) await ctx.session.switchAgent({ sessionID: input.path.id, agent: input.body.agent })
      if (input.body?.model !== undefined) {
        await ctx.session.switchModel({ sessionID: input.path.id, model: {
          id: input.body.model.modelID,
          providerID: input.body.model.providerID,
          variant: input.body.variant,
        } })
      }
      return ctx.session.prompt(payload)
    })
    const settled = operation.then(() => {}, () => {})
    admissions.set(input.path.id, settled)
    void settled.then(() => { if (admissions.get(input.path.id) === settled) admissions.delete(input.path.id) })
    return operation
  }
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
      const body = input?.body
      if (body?.permission !== undefined) return unsupportedV1Call("session.create.permission")
      const session = await ctx.session.create({
        parentID: body?.parentID,
        title: body?.title,
        agent: body?.agent,
        model: body?.model ? { id: body.model.modelID, providerID: body.model.providerID } : undefined,
        location: { directory: input?.query?.directory ?? ctx.location.directory },
      })
      return { data: { ...session, directory: session.location.directory } }
    },
    messages: async (input: SessionPath & { readonly query?: { readonly limit?: number } }) => {
      if (input.query?.limit !== undefined) return unsupportedV1Call("session.messages.limit")
      const messages = await ctx.session.context({ sessionID: input.path.id })
      return { data: messages.map((message) => projectV1Message(message, input.path.id)) }
    },
    promptAsync: async (input: PromptInput) => {
      const receipt = await admit(input, "session.promptAsync")
      return { data: receipt }
    },
    prompt: async (input: PromptInput) => {
      const receipt = await admit(input, "session.prompt")
      if (input.body?.noReply) return { data: projectV1Message({ ...receipt.payload, id: receipt.id, time: receipt.time, type: "user" }, input.path.id) }
      await ctx.session.wait({ sessionID: input.path.id })
      const messages = await ctx.session.context({ sessionID: input.path.id })
      const boundary = messages.findIndex((message) => message.id === receipt.id)
      const response = messages.slice(boundary + 1).findLast((message) => message.type === "assistant")
      if (boundary < 0 || !response) return unsupportedV1Call("session.prompt.response")
      return { data: projectV1Message(response, input.path.id) }
    },
    abort: async (input: SessionPath) => ({ data: await ctx.session.interrupt({ sessionID: input.path.id }) }),
    delete: async (input: SessionPath) => { await ctx.session.remove({ sessionID: input.path.id }); return { data: true } },
    status: async () => unsupportedV1Call("session.status"),
    todo: async (input: SessionPath) => ({ data: await nativeTodos(ctx.session, input.path.id) }),
    children: async () => unsupportedV1Call("session.children"),
  }, "session")
}
