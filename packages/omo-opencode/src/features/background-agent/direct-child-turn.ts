import { isSyntheticOrInternalUserMessage, isTerminalNoReplyUserMessage, log } from "../../shared"
import type { OpencodeClient } from "./opencode-client"

export async function readDirectChildPrompt(
  client: OpencodeClient,
  input: { sessionID: string; messageID: string; directory: string },
): Promise<string | undefined> {
  try {
    const response = await client.session.messages({
      path: { id: input.sessionID },
      query: { directory: input.directory, limit: 20 },
    })
    const message = response.data?.find(({ info }) => info.id === input.messageID && info.role === "user")
    if (!message || message.parts.length === 0 || message.parts.every((part) => "synthetic" in part && part.synthetic)) {
      return undefined
    }
    if ("noReply" in message.info && message.info.noReply === true) return undefined
    if (isSyntheticOrInternalUserMessage(message) || isTerminalNoReplyUserMessage(message)) return undefined
    return message.parts.flatMap((part) => part.type === "text" && !part.synthetic ? [part.text] : []).join("\n\n")
  } catch (error) {
    if (!(error instanceof Error)) throw error
    log("[background-agent] Could not read the direct child prompt:", { sessionID: input.sessionID, error })
    return undefined
  }
}
