import assert from "node:assert/strict"
import { z } from "zod"

const text = z.looseObject({ type: z.literal("text"), text: z.string() })
const tool = z.looseObject({ type: z.literal("tool"), name: z.string(), state: z.looseObject({ status: z.string(), content: z.array(z.unknown()).optional(), metadata: z.record(z.string(), z.unknown()).optional(), error: z.unknown().optional() }) })
const message = z.looseObject({ id: z.string(), type: z.string(), content: z.array(z.unknown()).optional() })
export const messages = z.object({ data: z.array(message) })
export const sessionRecord = z.looseObject({ id: z.string(), parentID: z.string().optional(), agent: z.string().optional(), model: z.looseObject({ providerID: z.string(), id: z.string(), variant: z.string().optional() }).optional() })
export const sessions = z.object({ data: z.array(sessionRecord) })
export const sessionGet = z.object({ data: sessionRecord })
export const created = z.object({ data: z.object({ id: z.string() }) })

export function latestTool(value: unknown, name: string) {
  const parts = messages.parse(value).data.flatMap((entry) => entry.content ?? [])
  const calls = parts.flatMap((part) => { const parsed = tool.safeParse(part); return parsed.success && parsed.data.name === name ? [parsed.data] : [] })
  const call = calls.at(-1)
  assert.ok(call, `${name} did not execute`)
  return call
}

export function toolText(value: unknown, name: string): string {
  const call = latestTool(value, name)
  assert.equal(call.state.status, "completed", `${name} did not complete: ${JSON.stringify(call.state)}`)
  return (call?.state.content ?? []).flatMap((part) => { const parsed = text.safeParse(part); return parsed.success ? [parsed.data.text] : [] }).join("\n")
}

export function assistantText(value: unknown): string {
  return messages.parse(value).data.filter((entry) => entry.type === "assistant").flatMap((entry) => entry.content ?? [])
    .flatMap((part) => { const parsed = text.safeParse(part); return parsed.success ? [parsed.data.text] : [] }).join("\n")
}
