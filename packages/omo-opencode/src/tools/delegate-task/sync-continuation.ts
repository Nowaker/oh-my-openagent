import type { DelegateTaskArgs, ToolContextWithMetadata } from "./types"
import type { ExecutorContext, ParentContext, SessionMessage } from "./executor-types"
import { getDeliverableTag } from "./constants"
import { handedBackSyncSessions, updateSessionAgent } from "../../features/claude-code-session-state"
import { publishToolMetadata } from "../../features/tool-metadata-store"
import { getTaskToastManager } from "../../features/task-toast-manager"
import { getMessageDir, normalizeSDKResponse } from "../../shared"
import { promptWithModelSuggestionRetry } from "../../shared/model-suggestion-retry"
import { resolveMessageContext } from "../../features/hook-message-injector"
import { formatDuration } from "./time-formatter"
import { syncContinuationDeps, type SyncContinuationDeps } from "./sync-continuation-deps"
import { setSessionTools } from "../../shared/session-tools-store"
import { buildTaskPrompt } from "./prompt-builder"
import { buildTaskMetadataBlock } from "../../features/tool-metadata-store/task-metadata-contract"
import { getTaskID } from "./task-id"
import { resolveMetadataModel } from "./resolve-metadata-model"
import { log } from "../../shared/logger"
import { formatDeletedSyncSessionError, isSyncSessionDeleted } from "./sync-session-existence"
import { cancelSyncSessionCleanup, scheduleSyncSessionCleanup } from "./sync-session-cleanup"
import { getSessionModel, setSessionModel } from "../../shared/session-model-state"
import { applySessionPromptParams } from "../../shared/session-prompt-params-helpers"
import { buildPromptGenerationParams, buildSyncPromptTools } from "./sync-prompt-sender"
import { SyncResumeStore } from "./sync-resume-store"

type ResumeModel = { providerID: string; modelID: string }

type ResumeContext = {
  resumeAgent?: string
  resumeModel?: ResumeModel
  resumeVariant?: string
  anchorMessageCount?: number
  anchorMessageID?: string
}

function shouldAttemptPollErrorRecovery(pollError: string): boolean {
  const trimmed = pollError.trim()

  if (trimmed.length === 0) {
    return false
  }

  if (/\bMessageAbortedError\b/u.test(trimmed)) {
    return true
  }

  if (/\bDOMException\b/u.test(trimmed) && /\bAbortError\b/u.test(trimmed)) {
    return true
  }

  if (/\bAbortError\b/u.test(trimmed) && !/\bTask aborted\b/u.test(trimmed)) {
    return true
  }

  if (/^the operation was aborted\.?$/iu.test(trimmed)) {
    return true
  }

  return false
}

async function resolveResumeContext(
  client: ExecutorContext["client"],
  continuationID: string
): Promise<ResumeContext> {
  try {
    const messagesResp = await client.session.messages({ path: { id: continuationID } })
    const messages = normalizeSDKResponse(messagesResp, [] as SessionMessage[])

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

export async function executeSyncContinuation(
  args: DelegateTaskArgs,
  ctx: ToolContextWithMetadata,
  executorCtx: ExecutorContext,
  parentContext: ParentContext,
  deps: SyncContinuationDeps = syncContinuationDeps,
  systemContent?: string
): Promise<string> {
  const { client, syncPollTimeoutMs, taskCleanupDelayMs, sisyphusAgentConfig } = executorCtx
  const toastManager = getTaskToastManager()
  const continuationID = getTaskID(args)
  if (!continuationID) {
    throw new Error("task_id is required to continue a sync task")
  }
  if (await isSyncSessionDeleted(client, continuationID)) {
    log("[task] Refusing to continue deleted sync session", { sessionID: continuationID })
    return formatDeletedSyncSessionError(continuationID)
  }
  cancelSyncSessionCleanup(continuationID)
  const retireSessionRuntime = executorCtx.manager?.retireSessionRuntime?.bind(executorCtx.manager)
  const detachFromManager = executorCtx.manager?.attachSyncContinuation?.(continuationID)
  const taskId = `resume_sync_${continuationID.slice(0, 8)}`
  const startTime = new Date()

  if (toastManager) {
    toastManager.addTask({
      id: taskId,
      description: args.description,
      agent: "continue",
      isBackground: false,
    })
  }

  let resumeAgent: string | undefined
  let resumeModel: ResumeModel | undefined
  let resumeVariant: string | undefined
  let anchorMessageCount: number | undefined
  let anchorMessageID: string | undefined
  let handedBackToParent = false
  let retirementAllowed = true

  try {
    const resumeContext = await resolveResumeContext(client, continuationID)
    const resumeStore = new SyncResumeStore()
    const syncSaved = resumeStore.read(continuationID)
    retirementAllowed = syncSaved !== undefined
    const saved = syncSaved ?? await executorCtx.manager?.prepareSyncContinuation?.(continuationID)
    retirementAllowed = true
    resumeAgent = resumeContext.resumeAgent ?? saved?.agent
    resumeModel = resumeContext.resumeModel ?? getSessionModel(continuationID) ?? saved?.model
    const sameSavedModel = resumeModel?.providerID === saved?.model?.providerID && resumeModel?.modelID === saved?.model?.modelID
    const modelConfig = resumeModel ? { ...saved?.model, ...resumeModel, variant: sameSavedModel ? saved?.model?.variant : undefined } : undefined
    const lowered = applySessionPromptParams(continuationID, modelConfig)
    resumeVariant = resumeContext.resumeVariant ?? (modelConfig?.reasoning !== undefined ? lowered.variant : modelConfig?.variant)
    const promptModel = modelConfig?.reasoning !== undefined ? { ...modelConfig, reasoningEffort: lowered.reasoningEffort } : modelConfig
    const tools = { ...saved?.tools, ...buildSyncPromptTools(resumeAgent ?? "continue") }
    for (const [tool, allowed] of Object.entries(saved?.tools ?? {})) {
      if (!allowed) tools[tool] = false
    }
    if (resumeAgent) {
      updateSessionAgent(continuationID, resumeAgent)
      // Background children must pass their manager's ownership check on every resume.
      if (syncSaved || !saved) {
        resumeStore.write({ version: 1, sessionId: continuationID, agent: resumeAgent, model: modelConfig ? { ...modelConfig, variant: resumeVariant } : undefined, tools })
      }
    }
    if (resumeModel) setSessionModel(continuationID, resumeModel)
    setSessionTools(continuationID, tools)
    anchorMessageCount = resumeContext.anchorMessageCount
    anchorMessageID = resumeContext.anchorMessageID

    const resumeModelForMetadata = resumeModel && resumeVariant !== undefined
      ? { ...resumeModel, variant: resumeVariant }
      : resumeModel

    const syncContMeta = {
      title: args.description,
      metadata: {
        prompt: args.prompt,
        ...(resumeAgent !== undefined ? { agent: resumeAgent } : {}),
        ...(args.category !== undefined ? { category: args.category } : {}),
        ...(args.requested_subagent_type !== undefined ? { requested_subagent_type: args.requested_subagent_type } : {}),
        load_skills: args.load_skills,
        description: args.description,
        run_in_background: args.run_in_background,
        taskId: continuationID,
        sessionId: continuationID,
        sync: true,
        command: args.command,
        model: resolveMetadataModel(resumeModelForMetadata, parentContext.model),
      },
    }
    await publishToolMetadata(ctx, syncContMeta)

    const tddEnabled = sisyphusAgentConfig?.tdd
    const effectivePrompt = buildTaskPrompt(args.prompt, resumeAgent, tddEnabled)

    await promptWithModelSuggestionRetry(client, {
      path: { id: continuationID },
      body: {
        ...(resumeAgent !== undefined ? { agent: resumeAgent } : {}),
        ...(resumeModel !== undefined ? { model: resumeModel } : {}),
        ...(resumeVariant !== undefined ? { variant: resumeVariant } : {}),
        ...buildPromptGenerationParams(promptModel),
        system: systemContent,
        tools,
        parts: [{ type: "text", text: effectivePrompt }],
      },
    }, {
      queueBehavior: "defer",
      checkToolState: false,
    })
   } catch (promptError) {
     if (toastManager) {
       toastManager.removeTask(taskId)
     }
     const errorMessage = promptError instanceof Error ? promptError.message : String(promptError)
     detachFromManager?.()
     if (retirementAllowed) scheduleSyncSessionCleanup(continuationID, taskCleanupDelayMs, retireSessionRuntime)
     return `Failed to send continuation prompt: ${errorMessage}\n\nTask ID: ${continuationID}`
   }

    try {
      const pollError = await deps.pollSyncSession(ctx, client, {
        sessionID: continuationID,
        agentToUse: resumeAgent ?? "continue",
        toastManager,
        taskId,
        anchorMessageCount,
        anchorMessageID,
        maxAssistantTurns: executorCtx.syncMaxAssistantTurns,
      }, syncPollTimeoutMs)
      if (pollError && shouldAttemptPollErrorRecovery(pollError)) {
        if (anchorMessageCount === undefined) {
          return pollError
        }
        const recoveredResult = await deps.fetchSyncResult(client, continuationID, anchorMessageCount, {
          strictAbortRecovery: true,
          deliverableTag: getDeliverableTag(resumeAgent),
        })
        if (!recoveredResult.ok) {
          return pollError
        }

        const duration = formatDuration(startTime)
        handedBackToParent = true

        return `Task continued and completed in ${duration}.

---

${recoveredResult.textContent || "(No text output)"}

${buildTaskMetadataBlock({
          sessionId: continuationID,
          taskId: continuationID,
          agent: resumeAgent,
          category: args.category,
        })}`
      } else if (pollError) {
        return pollError
      }

      const result = await deps.fetchSyncResult(client, continuationID, anchorMessageCount, {
        deliverableTag: getDeliverableTag(resumeAgent),
      })
      if (!result.ok) {
        return result.error
      }

     const duration = formatDuration(startTime)
     handedBackToParent = true

     return `Task continued and completed in ${duration}.

---

${result.textContent || "(No text output)"}

${buildTaskMetadataBlock({
        sessionId: continuationID,
        taskId: continuationID,
        agent: resumeAgent,
        category: args.category,
      })}`
   } finally {
     if (toastManager) {
       toastManager.removeTask(taskId)
     }
     if (handedBackToParent) {
       handedBackSyncSessions.add(continuationID)
       if (typeof client.session.abort === "function") {
         void client.session.abort({ path: { id: continuationID } }).catch((error: unknown) => {
           log(`[task] Failed to abort completed sync continuation session:`, error)
         })
       }
     }
     // Every terminal continuation path must restore the cleanup grace timer,
     // including prompt/poll failures after revival cancelled the old timer.
     detachFromManager?.()
     scheduleSyncSessionCleanup(continuationID, taskCleanupDelayMs, retireSessionRuntime)
   }
}
