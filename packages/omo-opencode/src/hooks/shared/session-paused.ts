import { isRecord } from "@oh-my-opencode/utils"

type SessionStatusClient = {
  readonly session?: { readonly status?: () => Promise<unknown> }
}

export async function isSessionPaused(client: SessionStatusClient, sessionID: string): Promise<boolean> {
  const response = await client.session?.status?.().catch(() => undefined)
  const statuses = isRecord(response) && isRecord(response.data) ? response.data : response
  const status = isRecord(statuses) ? statuses[sessionID] : undefined
  return isRecord(status) && status.paused != null
}
