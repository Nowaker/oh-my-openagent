import type { SessionContext } from "@opencode/plugin/promise/session"
import type { HookOutput } from "./hook-bridge-types"

export function buildChatParamsView(options: SessionContext["options"]) {
  const touched = new Set<string>()
  const scalars = { temperature: options.temperature ?? 1, topP: options.topP ?? 1, topK: options.topK ?? 0 }
  const output: HookOutput<"chat.params"> = {
    get temperature() { return scalars.temperature },
    set temperature(value) { touched.add("temperature"); scalars.temperature = value },
    get topP() { return scalars.topP },
    set topP(value) { touched.add("topP"); scalars.topP = value },
    get topK() { return scalars.topK },
    set topK(value) { touched.add("topK"); scalars.topK = value },
    maxOutputTokens: options.maxTokens, options: { ...options },
  }
  return { output, touched }
}

export function applyChatParamsView(options: SessionContext["options"], view: ReturnType<typeof buildChatParamsView>): void {
  const { output, touched } = view
  for (const key of Object.keys(options)) delete options[key]
  Object.assign(options, output.options)
  for (const [key, value] of [
    ["temperature", output.temperature], ["topP", output.topP],
    ["topK", output.topK], ["maxTokens", output.maxOutputTokens],
  ] as const) {
    if (key !== "maxTokens" && !touched.has(key) && Object.hasOwn(output, key)) continue
    if (value === undefined) delete options[key]
    else options[key] = value
  }
}
