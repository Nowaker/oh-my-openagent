import type { DefaultModeConfig } from "../config/schema/default-mode"
import { reconcileSisyphusRuntimePrompt } from "../agents/sisyphus-runtime-prompt-reconciler"
import { reconcileNativeModelPrompts } from "../agents/native-model-prompt"
import type { NativePromptContext } from "../agents/native-prompt-frame"
import { readAutoSwitchContext } from "./auto-switch"

const ULTRAWORK_MODE_TAG = "<ultrawork-mode>"

type UltraworkRestoration = {
  getSystemTransformGuidance?: (sessionID: string, modelID?: string, effectiveAgent?: string) => string | undefined
}

/**
 * Collapse the opencode hook model record into the canonical
 * `"<providerID>/<id>"` string used throughout OMO (model ids arrive bare for
 * builtin providers). Ids that already carry a provider prefix pass through
 * unchanged so both hook payload shapes stay comparable.
 */
function toCanonicalModel(model: { id: string; providerID: string } | undefined): string | undefined {
  if (!model?.id) return undefined
  if (!model.providerID || model.id.startsWith(`${model.providerID}/`)) return model.id
  return `${model.providerID}/${model.id}`
}

export function createSystemTransformHandler(
  defaultMode?: DefaultModeConfig,
  getUltraworkMessage?: (agentName?: string, modelID?: string) => string,
  ultraworkRestoration?: UltraworkRestoration | null,
  getToolSnippets?: () => Record<string, string>,
  getSessionToolPermissions?: (sessionID?: string) => Promise<NativePromptContext["toolPermissions"]>,
): (
  input: { sessionID?: string; model: { id: string; providerID: string; [key: string]: unknown } },
  output: { system: string[] },
) => Promise<void> {
  return async (input, output): Promise<void> => {
    // The Sisyphus prompt body is model-specific and baked at registration
    // from the *configured* model in .omo/omo.jsonc. This per-request hook
    // is the only seam that knows the model actually selected at runtime, so
    // rebuild the whole body for the runtime model here (issue #5297/#6966).
    const context = readAutoSwitchContext(input)
    const effective = context?.effective
    const runtimeModel = toCanonicalModel(input.model)
    if (!context || context.preferred.agent === context.effective.agent) {
      reconcileSisyphusRuntimePrompt(output.system, runtimeModel)
    }
    const runtimePermissions = await getSessionToolPermissions?.(input.sessionID)
    const canRefreshTools = !getSessionToolPermissions || runtimePermissions !== undefined
    reconcileNativeModelPrompts(
      output.system,
      runtimeModel,
      canRefreshTools ? getToolSnippets?.() : undefined,
      undefined,
      runtimePermissions,
    )

    const restoredGuidance = input.sessionID
      ? ultraworkRestoration?.getSystemTransformGuidance?.(
          input.sessionID,
          effective?.modelID ?? input.model?.id,
          effective?.agent,
        )
      : undefined
    if (restoredGuidance) {
      if (!output.system.some((part) => part.includes(ULTRAWORK_MODE_TAG))) {
        output.system.push(restoredGuidance)
      }
      return
    }

    if (!defaultMode?.ultrawork || !getUltraworkMessage) return

    // Avoid re-injecting if the ultrawork prompt is already in the system prompt
    // (e.g. after compaction the system prompt is rebuilt and this hook fires again)
    if (output.system.some((part) => part.includes(ULTRAWORK_MODE_TAG))) return

    const ultraworkMessage = getUltraworkMessage(effective?.agent ?? "sisyphus", effective?.modelID ?? input.model?.id)
    if (!ultraworkMessage) return

    output.system.push(ultraworkMessage)
  }
}
