import type { Hooks, ToolContext as V1ToolContext, ToolResult as V1ToolResult } from "@opencode-ai/plugin"
import { tool as v1ToolFactory } from "@opencode-ai/plugin/tool"
import type { Plugin } from "@opencode/plugin"
import { z } from "zod"
import { log } from "../shared/logger"

class ToolSchemaBridgeError extends Error {
  constructor(readonly toolName: string, readonly fieldName: string, cause: unknown) {
    super(`Cannot encode ${toolName}.${fieldName}`, { cause })
    this.name = "ToolSchemaBridgeError"
  }
}

function encodeField(field: object): Record<string, unknown> {
  // Re-converting the v1 registry's encoder leaves described-schema parents unseen in Zod's outer traversal.
  const internals: unknown = Reflect.get(field, "_zod")
  const normalized: unknown = internals && typeof internals === "object" ? Reflect.get(internals, "toJSONSchema") : undefined
  const encoder: unknown = Reflect.get(field, "toJSONSchema")
  const encoded: unknown = typeof normalized === "function"
    ? Reflect.apply(normalized, undefined, [])
    : typeof encoder === "function"
      ? Reflect.apply(encoder, field, [])
      : Reflect.apply(v1ToolFactory.schema.toJSONSchema, undefined, [field])
  const schema = z.record(z.string(), z.unknown()).parse(encoded)
  delete schema.$schema
  return schema
}

function resultContent(result: V1ToolResult) {
  if (typeof result === "string") return { content: result }
  const attachments = (result.attachments ?? []).map((attachment) => ({
    type: "file" as const,
    uri: attachment.url,
    mime: attachment.mime,
    ...(attachment.filename === undefined ? {} : { name: attachment.filename }),
  }))
  return {
    content: [{ type: "text" as const, text: result.output }, ...attachments],
    metadata: { ...result.metadata, ...(result.title === undefined ? {} : { title: result.title }) },
  }
}

export async function registerV1Tools(ctx: Plugin.Context, tools: NonNullable<Hooks["tool"]>): Promise<void> {
  await ctx.tool.transform((editor) => {
    for (const [name, definition] of Object.entries(tools)) {
      const args = v1ToolFactory.schema.object(definition.args)
      const properties = Object.fromEntries(Object.entries(definition.args).map(([key, field]) => {
        try { return [key, encodeField(field)] }
        catch (error) { throw new ToolSchemaBridgeError(name, key, error) }
      }))
      const required = Object.entries(definition.args).filter(([, field]) => !v1ToolFactory.schema.safeParse(field, undefined).success).map(([key]) => key)
      editor.add({
        name,
        description: definition.description,
        options: { codemode: false },
        input: { type: "object", properties, required, additionalProperties: false },
        execute: async (input, context) => {
          const v1context: V1ToolContext = {
            sessionID: context.sessionID,
            messageID: context.messageID,
            agent: context.agent,
            directory: ctx.location.directory,
            worktree: ctx.location.project?.canonical ?? ctx.location.directory,
            abort: context.signal,
            metadata: (update) => {
              void context.progress(update).catch((error: unknown) => {
                log("[plugin-v2] tool progress failed", { tool: name, error: error instanceof Error ? error.message : String(error) })
              })
            },
            ask: async (request) => {
              await ctx.permission.assert({
                sessionID: context.sessionID,
                agent: context.agent,
                action: request.permission,
                resources: request.patterns,
                save: request.always,
                metadata: request.metadata,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
            },
          }
          return resultContent(await definition.execute(args.parse(input), v1context))
        },
      })
    }
  })
  log("[plugin-v2] tool definitions submitted", { names: Object.keys(tools) })
}
