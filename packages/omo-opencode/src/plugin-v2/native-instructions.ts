import { createHash } from "node:crypto"
import type { Plugin } from "@opencode/plugin"
import type { CreatedHooks } from "../create-hooks"

type InstructionContext = { readonly session: Pick<Plugin.Context["session"], "instructions"> }
type InstructionHooks = Pick<CreatedHooks, "rulesInjector" | "keywordDetector">
type InstructionValue = Parameters<Plugin.Context["session"]["instructions"]["entry"]["put"]>[0]["value"]

export type NativeInstructions = {
  readonly put: (sessionID: string, key: string, value: InstructionValue) => Promise<void>
  readonly wrap: <T extends InstructionHooks>(hooks: T) => T
}

export function createNativeInstructions(ctx: InstructionContext): NativeInstructions {
  const put = async (sessionID: string, key: string, value: InstructionValue): Promise<void> => {
    await ctx.session.instructions.entry.put({ sessionID, key, value })
  }

  const wrap = <T extends InstructionHooks>(hooks: T): T => {
    const rules = hooks.rulesInjector
    const keyword = hooks.keywordDetector
    return {
      ...hooks,
      rulesInjector: rules ? {
        ...rules,
        "tool.execute.after": async (input, output) => {
          const original = output.output
          await rules["tool.execute.after"](input, output)
          if (output.output === original || !output.output.startsWith(original)) return
          const text = output.output.slice(original.length)
          const digest = createHash("sha256").update(text).digest("hex")
          await put(input.sessionID, `omo-rules-${digest}`, text)
          output.output = original
        },
      } : null,
      keywordDetector: keyword ? {
        ...keyword,
        "chat.message": async (input, output) => {
          const originals = new Map(output.parts.map((part) => [part, part.text]))
          await keyword["chat.message"](input, output)
          const guidance: string[] = []
          const restored = output.parts.flatMap((part) => {
            const original = originals.get(part)
            if (typeof original === "string" && typeof part.text === "string" && part.text.startsWith(original)) {
              const suffix = part.text.slice(original.length)
              if (suffix) guidance.push(suffix)
              return [{ ...part, text: original }]
            }
            if (!originals.has(part) && part.synthetic === true && part.type === "text" && typeof part.text === "string") {
              if (part.text !== "<ultrawork-mode>active</ultrawork-mode>") guidance.push(part.text)
              return []
            }
            return [part]
          })
          if (guidance.length > 0) await put(input.sessionID, "omo-mode", guidance.join("\n\n"))
          output.parts = restored
        },
      } : null,
    }
  }

  return { put, wrap }
}
