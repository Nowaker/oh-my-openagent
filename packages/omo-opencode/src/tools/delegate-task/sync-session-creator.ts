import type { OpencodeClient } from "./types"
import type { DelegatedModelConfig } from "../../shared/model-resolution-types"
import { QUESTION_DENIED_SESSION_PERMISSION } from "../../shared/question-denied-session-permission"
import { forkParentAsChildSession } from "../../features/background-agent/fork-child-session"
import { normalizeSDKResponse } from "../../shared"

export async function createSyncSession(
  client: OpencodeClient,
  input: {
    parentSessionID: string
    agentToUse: string
    description: string
    defaultDirectory: string
    category?: string
    categoryModel?: DelegatedModelConfig
    forkFromParent?: boolean
  }
): Promise<{ ok: true; sessionID: string; parentDirectory: string; anchorMessageCount?: number } | { ok: false; error: string }> {
  const parentSession = await client.session.get({ path: { id: input.parentSessionID } }).catch(() => null)
  const parentDirectory = parentSession?.data?.directory ?? input.defaultDirectory

  if (input.forkFromParent) {
    try {
      const sessionID = await forkParentAsChildSession(client, {
        parentSessionID: input.parentSessionID,
        title: `${input.description} (@${input.agentToUse} fork)`,
        directory: parentDirectory,
        permission: QUESTION_DENIED_SESSION_PERMISSION,
      })
      // The copied history is not the child's work: polling and the result read start after it.
      const copied = normalizeSDKResponse(await client.session.messages({ path: { id: sessionID } }), [] as unknown[])
      return { ok: true, sessionID, parentDirectory, anchorMessageCount: Array.isArray(copied) ? copied.length : 0 }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  const createResult = await client.session.create({
    body: {
      parentID: input.parentSessionID,
      title: `${input.category ? `[${input.category}] ` : ""}${input.description} (@${input.agentToUse} subagent)`,
      permission: QUESTION_DENIED_SESSION_PERMISSION,
      ...(input.categoryModel
        ? {
            model: {
              id: input.categoryModel.modelID,
              providerID: input.categoryModel.providerID,
              ...(input.categoryModel.variant ? { variant: input.categoryModel.variant } : {}),
            },
          }
        : {}),
    } as Record<string, unknown>,
    query: {
      directory: parentDirectory,
    },
  })

  if (createResult.error !== undefined) {
    return { ok: false, error: `Failed to create session: ${createResult.error}` }
  }
  if (createResult.data === undefined) {
    return { ok: false, error: "Failed to create session: missing session data" }
  }

  return { ok: true, sessionID: createResult.data.id, parentDirectory }
}
