import type { OpencodeClient } from "./types"
import type { SessionMessage } from "./executor-types"
import { getMessageDir, normalizeSDKResponse } from "../../shared"
import { resolveMessageContext } from "../../features/hook-message-injector"

export type ResumeContext = {
  resumeAgent?: string
  resumeModel?: { providerID: string; modelID: string }
  resumeVariant?: string
  anchorMessageCount?: number
  anchorMessageID?: string
}

export async function resolveResumeContext(client: OpencodeClient, continuationID: string): Promise<ResumeContext> {
  try {
    const messagesResp = await client.session.messages({ path: { id: continuationID } })
    const messages = normalizeSDKResponse<SessionMessage[]>(messagesResp, [])
    const context: ResumeContext = { anchorMessageCount: messages.length, anchorMessageID: messages.at(-1)?.info?.id }
    for (let index = messages.length - 1; index >= 0; index--) {
      const info = messages[index].info
      context.resumeAgent ??= info?.agent
      if (!context.resumeModel) {
        context.resumeModel = info?.model ?? (info?.providerID && info.modelID
          ? { providerID: info.providerID, modelID: info.modelID }
          : undefined)
        if (context.resumeModel) context.resumeVariant = info?.variant ?? info?.model?.variant
      }
      if (context.resumeAgent && context.resumeModel) break
    }
    return context
  } catch (error) {
    if (!(error instanceof Error)) throw error
    const resumeMessageDir = getMessageDir(continuationID)
    const { prevMessage } = await resolveMessageContext(continuationID, client, resumeMessageDir)
    const resumeMessageModel = prevMessage?.model
    return {
      resumeAgent: prevMessage?.agent,
      resumeModel: resumeMessageModel?.providerID && resumeMessageModel.modelID
        ? { providerID: resumeMessageModel.providerID, modelID: resumeMessageModel.modelID }
        : undefined,
      resumeVariant: resumeMessageModel?.variant,
    }
  }
}
