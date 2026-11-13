const nativeClients = new WeakSet<object>()

export function markNativeDelegationClient<T extends object>(client: T): T {
  nativeClients.add(client)
  return client
}

export function isNativeDelegationClient(client: object): boolean {
  return nativeClients.has(client)
}

export function delegationAgentForClient(client: object, agent: string): string {
  return isNativeDelegationClient(client) ? normalizeAgentForPromptKey(agent) ?? agent : agent
}
import { normalizeAgentForPromptKey } from "./agent-display-names"
