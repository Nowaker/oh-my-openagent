import type { Plugin } from "@opencode-ai/plugin"
import { createHephaestusAgentsMdInjectorHook } from "../../../packages/omo-opencode/src/hooks/hephaestus-agents-md-injector/hook"
import { appendFileSync } from "node:fs"

export default (async (input) => {
  const hook = createHephaestusAgentsMdInjectorHook(input)
  return {
    ...hook,
    "chat.message": async (request, output) => {
      await hook["chat.message"](request, output)
      appendFileSync(`${process.env.XDG_DATA_HOME}/injector-proof.jsonl`, JSON.stringify({ messageID: output.message.id, parts: output.parts.map((part) => ({ type: part.type, id: part.id, messageID: part.messageID, synthetic: part.type === "text" ? part.synthetic === true : false })) }) + "\n")
    },
  }
}) satisfies Plugin
