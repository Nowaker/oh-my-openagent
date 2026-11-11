import type { Hooks } from "@opencode-ai/plugin"
import type { Plugin } from "@opencode/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"

export type HookInput<K extends keyof Hooks> = Parameters<NonNullable<Hooks[K]> extends (...args: infer P) => unknown ? (...args: P) => unknown : never>[0]
export type HookOutput<K extends keyof Hooks> = Parameters<NonNullable<Hooks[K]> extends (...args: infer P) => unknown ? (...args: P) => unknown : never>[1]
export type ContextMessage = SessionContext["messages"][number]
export type ContextPart = ContextMessage["content"][number]
export type MessageView = HookOutput<"experimental.chat.messages.transform">["messages"][number]
export type BridgeContext = Pick<Plugin.Context, "session" | "tool" | "shell" | "event" | "model" | "provider" | "location">
export type Registration = { readonly dispose: () => Promise<void> }
export type NativeEvent = ReturnType<Plugin.Context["event"]["subscribe"]> extends AsyncIterable<infer E> ? E : never

export class UnsupportedHookMappingError extends Error {
  constructor(readonly mapping: string) {
    super(`Unsupported v2 hook mapping: ${mapping}`)
    this.name = "UnsupportedHookMappingError"
  }
}

export function assertExhaustive(value: never): never {
  throw new UnsupportedHookMappingError("unrecognized-variant")
}
