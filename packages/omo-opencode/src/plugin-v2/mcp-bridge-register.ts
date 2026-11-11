import type { Plugin } from "@opencode/plugin"
import { z } from "zod"
import { log } from "../shared/logger"

const common = {
  enabled: z.boolean().optional(),
  timeout: z.number().optional(),
}
const mcpConfig = z.discriminatedUnion("type", [
  z.object({ type: z.literal("remote"), url: z.string().url(), headers: z.record(z.string(), z.string()).optional(), oauth: z.literal(false).optional(), ...common }),
  z.object({ type: z.literal("local"), command: z.array(z.string()), environment: z.record(z.string(), z.string()).optional(), ...common }),
])

export async function registerV1Mcps(ctx: Plugin.Context, value: unknown): Promise<void> {
  const configs = z.record(z.string(), mcpConfig).parse(value ?? {})
  await ctx.mcp.transform((editor) => {
    for (const [name, config] of Object.entries(configs)) {
      const flags = {
        ...(config.enabled === undefined ? {} : { disabled: !config.enabled }),
        ...(config.timeout === undefined ? {} : { timeout: { startup: config.timeout } }),
      }
      switch (config.type) {
        case "remote":
          editor.set(name, { type: "remote", url: config.url, ...(config.headers === undefined ? {} : { headers: config.headers }), ...(config.oauth === undefined ? {} : { oauth: config.oauth }), ...flags })
          break
        case "local":
          editor.set(name, { type: "local", command: config.command, ...(config.environment === undefined ? {} : { environment: config.environment }), ...flags })
          break
      }
    }
  })
  log("[plugin-v2] MCP definitions registered", { names: Object.keys(configs) })
}
