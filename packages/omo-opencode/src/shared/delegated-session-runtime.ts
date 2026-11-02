import { clearSessionAgent, subagentSessions, syncSubagentSessions } from "../features/claude-code-session-state"
import { clearBackgroundOutputConsumptionsForParentSession, clearBackgroundOutputConsumptionsForTaskSession } from "./background-output-consumption"
import { clearDelegatedChildSessionBootstrap } from "./delegated-child-session-bootstrap"
import { SessionCategoryRegistry } from "./session-category-registry"
import { resetMessageCursor } from "./session-cursor"
import { clearSessionModel } from "./session-model-state"
import { clearSessionPromptParams } from "./session-prompt-params-state"
import { deleteSessionTools } from "./session-tools-store"

export function releaseDelegatedSessionRuntime(sessionID: string): void {
  clearSessionAgent(sessionID)
  subagentSessions.delete(sessionID)
  syncSubagentSessions.delete(sessionID)
  clearDelegatedChildSessionBootstrap(sessionID)
  SessionCategoryRegistry.remove(sessionID)
  resetMessageCursor(sessionID)
  clearBackgroundOutputConsumptionsForParentSession(sessionID)
  clearBackgroundOutputConsumptionsForTaskSession(sessionID)
  clearSessionModel(sessionID)
  clearSessionPromptParams(sessionID)
  deleteSessionTools(sessionID)
}
