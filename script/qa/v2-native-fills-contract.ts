import { z } from "zod"
import type { ProviderRequest, ToolCall } from "./v2-parity/provider"

export type { ProviderRequest } from "./v2-parity/provider"

export class NativeFillFailure extends Error {
  constructor(readonly check: string) {
    super(check)
    this.name = "NativeFillFailure"
  }
}

export function requireProof(condition: unknown, check: string): asserts condition {
  if (!condition) throw new NativeFillFailure(check)
}

export const scenarioName = z.enum(["permission", "todos", "instructions", "default-mode", "overflow"])
export type ScenarioName = z.infer<typeof scenarioName>
export type NativeFixtures =
  | { readonly scenario: "permission"; readonly name: string; readonly marker: string }
  | { readonly scenario: "instructions"; readonly path: string; readonly marker: string; readonly compactionMarker: string }
  | { readonly scenario: "todos" | "overflow" | "default-mode" }
export type DriverOptions = {
  readonly evidenceRoot: string
  readonly binary: string
  readonly plugin: string
  readonly scenario: ScenarioName
}
export function modelRequestText(request: ProviderRequest): string {
  return request.messages.flatMap(({ content }) => {
    if (typeof content === "string") return [content]
    if (!Array.isArray(content)) return []
    return content.flatMap((part: unknown) => {
      const parsed = z.object({ text: z.string() }).safeParse(part)
      return parsed.success ? [parsed.data.text] : []
    })
  }).join("\n").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&").replace(/\s+/g, " ")
}

export function requestContainsInstruction(request: ProviderRequest, text: string): boolean {
  return modelRequestText(request).includes(text.replace(/\s+/g, " "))
}
export type ProviderReply = {
  readonly text?: string
  readonly call?: Omit<ToolCall, "id">
  readonly inputTokens?: number
}
export type ProviderScript = (request: ProviderRequest) => ProviderReply | Promise<ProviderReply>
export const nativeEvent = z.object({ type: z.string(), data: z.record(z.string(), z.unknown()) }).passthrough()
export type NativeEvent = z.infer<typeof nativeEvent>
const syntheticItem = z.object({ type: z.literal("synthetic"), payload: z.object({ metadata: z.object({ source: z.literal("omo.todo-continuation") }) }) })

export function isTodoContinuation(event: NativeEvent, sessionID: string): boolean {
  return event.type === "session.inbox.enqueued" && event.data["sessionID"] === sessionID && syntheticItem.safeParse(event.data["item"]).success
}
export const messageList = z.object({ data: z.array(z.object({
  id: z.string(), type: z.string(), status: z.string().optional(),
  text: z.string().optional(), metadata: z.record(z.string(), z.unknown()).optional(),
  content: z.array(z.object({
    type: z.string(), name: z.string().optional(), id: z.string().optional(),
    state: z.object({ status: z.string(), content: z.unknown().optional(), metadata: z.record(z.string(), z.unknown()).optional() }).passthrough().optional(),
  }).passthrough()).optional(),
}).passthrough()) })
export type NativeMessages = z.infer<typeof messageList>["data"]
export const todoList = z.array(z.object({ content: z.string(), status: z.enum(["pending", "in_progress", "completed", "cancelled"]) }))

export type ScenarioHost = {
  readonly root: string
  readonly project: string
  readonly requests: readonly ProviderRequest[]
  readonly events: readonly NativeEvent[]
  readonly signal: AbortSignal
  readonly fixtures: NativeFixtures
  readonly api: (path: string, body?: unknown) => Promise<unknown>
  readonly save: (name: string, value: unknown) => void
  readonly script: (respond: ProviderScript) => void
  readonly waitEvent: (predicate: (event: NativeEvent) => boolean, after?: number) => Promise<NativeEvent>
}

export async function createSession(host: ScenarioHost, permissions = [{ action: "*", resource: "*", effect: "allow" }]) {
  return z.object({ data: z.object({ id: z.string() }) }).parse(await host.api("/api/session", {
    title: "W8 native fills QA", agent: "sisyphus", model: { providerID: "fake", id: "fake-model" }, permissions,
  })).data.id
}

export async function captureMessages(host: ScenarioHost, sessionID: string, name: string) {
  const result = await host.api(`/api/session/${sessionID}/message?order=asc&limit=100`)
  host.save(name, result)
  return messageList.parse(result).data
}

export function toolsIn(messages: NativeMessages, name: string) {
  return messages.flatMap((message) => message.content ?? []).filter((part) => part.type === "tool" && part.name === name)
}

export function latestTodos(messages: NativeMessages) {
  const call = toolsIn(messages, "todowrite").findLast((part) => part.state?.status === "completed")
  return todoList.parse(call?.state?.metadata?.["todos"])
}

export async function settle(host: ScenarioHost, sessionID: string) {
  await host.api(`/api/experimental/session/${sessionID}/wait`, {})
}
