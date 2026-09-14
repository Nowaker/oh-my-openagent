import type { Plugin } from "@opencode-ai/plugin"
export default (async () => ({
  "chat.message": async (_input, output) => {
    output.parts.unshift({ type: "text", id: `prt_${crypto.randomUUID().replaceAll("-", "")}`, messageID: output.message.id, sessionID: output.message.sessionID, text: "SYNTHETIC_ONLY_SENTINEL", synthetic: true })
  },
})) satisfies Plugin
