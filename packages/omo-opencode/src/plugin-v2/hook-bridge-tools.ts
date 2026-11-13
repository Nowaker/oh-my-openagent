import type { Hooks } from "@opencode-ai/plugin"
import type { Plugin } from "@opencode/plugin"
import { z } from "zod"
import { log } from "../shared/logger"
import type { Registration } from "./hook-bridge-types"

type ToolEvent = Parameters<Parameters<Plugin.Context["tool"]["hook"]>[1]>[0]
type ToolAfter = Extract<ToolEvent, { readonly status: "completed" | "error" }>
type ToolBefore = Extract<ToolEvent, { input: unknown; tool: string; readonly status?: never }>
type ToolAfterInput = Pick<ToolAfter, "tool" | "input"> & { readonly sessionID: string; readonly id: string } & (
  { readonly status: "completed"; result: Extract<ToolAfter, { readonly status: "completed" }>["result"] } |
  { readonly status: "error"; error: Extract<ToolAfter, { readonly status: "error" }>["error"] }
)

export async function applyToolBefore(event: Pick<ToolBefore, "tool" | "input"> & { readonly sessionID: string; readonly id: string }, handler: NonNullable<Hooks["tool.execute.before"]>): Promise<void> {
  const output: { args: unknown } = { args: event.input }
  const input = { tool: event.tool, sessionID: event.sessionID, callID: event.id }
  try {
    await handler(input, output)
    event.tool = input.tool
    event.input = output.args
  } catch (error) {
    log("[v2-bridge] tool before hook failed", { tool: event.tool, errorName: error instanceof Error ? error.name : typeof error })
    throw error
  }
}

export async function applyToolAfter(event: ToolAfterInput, handler: NonNullable<Hooks["tool.execute.after"]>): Promise<void> {
  if (event.status !== "completed") return
  const result = event.result
  const content = result.content
  const text = typeof content === "string" ? content : content?.filter((part) => part.type === "text").map((part) => part.text).join("\n")
  const output = { title: typeof result.metadata?.title === "string" ? result.metadata.title : "", output: text ?? (typeof result.output === "string" ? result.output : ""), metadata: { ...result.metadata } }
  if (event.tool === "read" || event.tool === "write" || event.tool === "edit") {
    const path = z.object({ path: z.string() }).safeParse(event.input)
    if (path.success && output.metadata.filePath === undefined) output.metadata.filePath = path.data.path
  }
  const before = output.output
  try { await handler({ tool: event.tool, sessionID: event.sessionID, callID: event.id, args: event.input }, output) }
  catch (error) {
    log("[v2-bridge] tool after hook failed", { tool: event.tool, errorName: error instanceof Error ? error.name : typeof error })
    throw error
  }
  let updated = content
  if (before !== output.output) {
    if (Array.isArray(content)) {
      let inserted = false
      updated = content.flatMap((part) => {
        if (part.type !== "text") return [part]
        if (inserted) return []
        inserted = true
        return [{ type: "text" as const, text: output.output }]
      })
      if (!inserted) updated = [{ type: "text", text: output.output }, ...content]
    } else updated = output.output
  }
  event.result = {
    ...result, content: updated,
    ...(typeof result.output === "string" && before !== output.output ? { output: output.output } : {}),
    metadata: { ...output.metadata, title: output.title },
  }
}

export async function bridgeToolHooks(ctx: Plugin.Context, hooks: Hooks, registrations: Registration[]): Promise<void> {
  const before = hooks["tool.execute.before"]
  if (before) registrations.push(await ctx.tool.hook("execute.before", (event) => applyToolBefore(event, before)))
  const after = hooks["tool.execute.after"]
  if (after) registrations.push(await ctx.tool.hook("execute.after", (event) => applyToolAfter(event, after)))
  const shell = hooks["shell.env"]
  if (shell) {
    log("[v2-bridge] unsupported mapping", { mapping: "shell.env.source-session-message-call", reason: "shell.create.before has no execution identity or source tag" })
    registrations.push(await ctx.shell.hook("create.before", async (event) => {
      const output = { env: Object.fromEntries(Object.entries(event.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")) }
      await shell({ cwd: event.cwd }, output)
      Object.assign(event.env, output.env)
    }))
  }
}
