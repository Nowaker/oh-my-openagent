import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

import { getMessageDir, isSqliteBackend, normalizeSDKResponse } from "../../shared"
import { hasCompactionPartInStorage, isCompactionMessage } from "../../shared/compaction-marker"

type SessionLastAgentDeps = {
  getMessageDir: typeof getMessageDir
  isSqliteBackend: typeof isSqliteBackend
  normalizeSDKResponse: typeof normalizeSDKResponse
  hasCompactionPartInStorage: typeof hasCompactionPartInStorage
  isCompactionMessage: typeof isCompactionMessage
}

const defaultSessionLastAgentDeps: SessionLastAgentDeps = {
  getMessageDir,
  isSqliteBackend,
  normalizeSDKResponse,
  hasCompactionPartInStorage,
  isCompactionMessage,
}

type SessionMessagesClient = {
  session: {
    messages: (input: { path: { id: string }; query?: { limit: number; before?: string } }) => Promise<unknown>
  }
}

async function getLastAgentFromSessionMessages(
  sessionID: string,
  client: SessionMessagesClient,
  deps: SessionLastAgentDeps,
): Promise<string | null> {
  try {
    // The sidebar resolves active agents every heartbeat; do not transfer the
    // entire transcript just to find its newest non-compaction agent.
    const limit = 20
    let before: string | undefined
    while (true) {
      const response = await client.session.messages({ path: { id: sessionID }, query: { limit, before } })
      const messages = deps.normalizeSDKResponse(response, [] as Array<{
        id?: string
        agent?: string
        info?: { id?: string; agent?: string; time?: { created?: number } }
        parts?: Array<{ type?: string }>
      }>, {
        preferResponseOnMissingData: true,
      }).sort((left, right) => {
        const leftTime = left.info?.time?.created ?? Number.NEGATIVE_INFINITY
        const rightTime = right.info?.time?.created ?? Number.NEGATIVE_INFINITY
        if (leftTime !== rightTime) {
          return rightTime - leftTime
        }

        const leftId = left.info?.id ?? left.id ?? ""
        const rightId = right.info?.id ?? right.id ?? ""
        return rightId.localeCompare(leftId)
      })

      for (const message of messages) {
        if (deps.isCompactionMessage(message)) {
          continue
        }

        const agent = message.info?.agent ?? message.agent
        if (typeof agent === "string") {
          return agent.toLowerCase()
        }
      }
      if (messages.length < limit) return null
      const oldest = messages.at(-1)
      const next = oldest?.info?.id ?? oldest?.id
      if (!next || next === before) return null
      before = next
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return null
  }
}

export async function getLastAgentFromSession(
  sessionID: string,
  client?: SessionMessagesClient,
  deps: Partial<SessionLastAgentDeps> = {},
): Promise<string | null> {
  const resolvedDeps: SessionLastAgentDeps = {
    ...defaultSessionLastAgentDeps,
    ...deps,
  }

  const sqliteBackend = resolvedDeps.isSqliteBackend()
  if (client) {
    const sdkAgent = await getLastAgentFromSessionMessages(sessionID, client, resolvedDeps)
    if (sdkAgent !== null) {
      return sdkAgent
    }
    if (sqliteBackend) {
      return null
    }
  }

  const messageDir = resolvedDeps.getMessageDir(sessionID)
  if (!messageDir) return null

  try {
    const messages = readdirSync(messageDir)
      .filter((fileName) => fileName.endsWith(".json"))
      .map((fileName) => {
        try {
          const content = readFileSync(join(messageDir, fileName), "utf-8")
          const parsed = JSON.parse(content) as { id?: string; agent?: unknown; time?: { created?: unknown } }
          return {
            fileName,
            id: parsed.id,
            agent: parsed.agent,
            createdAt: typeof parsed.time?.created === "number" ? parsed.time.created : Number.NEGATIVE_INFINITY,
          }
        } catch (error) {
          if (!(error instanceof Error)) throw error
          return null
        }
      })
      .filter((message): message is { fileName: string; id: string | undefined; agent: unknown; createdAt: number } => message !== null)
      .sort((left, right) => (right?.createdAt ?? 0) - (left?.createdAt ?? 0) || (right?.fileName ?? "").localeCompare(left?.fileName ?? ""))

    for (const message of messages) {
      if (!message) continue
      if (resolvedDeps.isCompactionMessage({ agent: message.agent }) || resolvedDeps.hasCompactionPartInStorage(message?.id)) {
        continue
      }

      if (typeof message.agent === "string") {
        return message.agent.toLowerCase()
      }
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error
    if (client) {
      return getLastAgentFromSessionMessages(sessionID, client, resolvedDeps)
    }
    return null
  }

  if (client) {
    return getLastAgentFromSessionMessages(sessionID, client, resolvedDeps)
  }

  return null
}
