import { z } from "zod"
import type { PluginInstance } from "./types"
import { getAgentConfigKey } from "../shared/agent-display-names"

const routeSchema = z.object({
  agent: z.string().min(1),
  providerID: z.string(),
  modelID: z.string(),
  variant: z.string(),
})

const proposalSchema = z.object({
  version: z.literal(1),
  sessionID: z.string().min(1),
  source: routeSchema,
  target: routeSchema,
})

const contextInputSchema = z.object({
  autoSwitch: z.object({
    version: z.literal(1),
    preferred: routeSchema,
    effective: routeSchema,
  }),
})

type Route = Readonly<z.infer<typeof routeSchema>>
type AgentConfig = Parameters<NonNullable<PluginInstance["config"]>>[0]["agent"]
type AgentPin = { readonly model: string; readonly variant: string }
export type PrepareAutoSwitch = (input: unknown, output: { decision?: "allow" | "deny" }) => Promise<void>

function isOpusHigh(route: Route): boolean {
  return route.providerID === "anthropic" && route.modelID === "claude-opus-5-5" && route.variant === "high"
}

function isSol(route: Route): boolean {
  return route.providerID === "openai" && route.modelID === "gpt-6.2-sol"
}

function qualifiedRolePair(source: Route, target: Route) {
  if (isOpusHigh(source) && isSol(target) && target.variant === "xhigh") {
    return { source: "sisyphus", target: "hephaestus" }
  }
  if (isSol(source) && (source.variant === "xhigh" || source.variant === "max") && isOpusHigh(target)) {
    return { source: "hephaestus", target: "sisyphus" }
  }
  return undefined
}

function isQualifiedHop(source: Route, target: Route, allowModelOnly: boolean): boolean {
  const pair = qualifiedRolePair(source, target)
  if (!pair) return false
  if (allowModelOnly && source.agent === target.agent) return true
  return getAgentConfigKey(source.agent) === pair.source && getAgentConfigKey(target.agent) === pair.target
}

export function readAutoSwitchContext(input: unknown) {
  const hookInput = contextInputSchema.safeParse(input)
  if (!hookInput.success) return undefined
  const context = hookInput.data.autoSwitch
  const { preferred, effective } = context
  return isQualifiedHop(preferred, effective, true) ? context : undefined
}

export function readEffectiveAutoSwitchRoute(input: unknown): Route | undefined {
  return readAutoSwitchContext(input)?.effective
}

export function createAutoSwitchPolicy(canPrepareSession: (sessionID: string) => boolean) {
  let primaryAgents = new Map<string, AgentPin>()
  function isRegistered(route: Route): boolean {
    const pin = primaryAgents.get(route.agent)
    return pin?.model === `${route.providerID}/${route.modelID}` && pin.variant === route.variant
  }

  return {
    configure(agents: AgentConfig): void {
      const pins = new Map<string, AgentPin>()
      for (const [name, agent] of Object.entries(agents ?? {})) {
        if (
          agent?.mode === "primary" &&
          !agent.disable &&
          agent.hidden !== true &&
          typeof agent.prompt === "string" &&
          agent.prompt.length > 0 &&
          typeof agent.model === "string" &&
          typeof agent.variant === "string"
        ) {
          pins.set(name, { model: agent.model, variant: agent.variant })
        }
      }
      primaryAgents = pins
    },
    async prepare(input: unknown, output: Parameters<PrepareAutoSwitch>[1]): Promise<void> {
      const proposal = proposalSchema.safeParse(input)
      if (!proposal.success) {
        output.decision = "deny"
        return
      }
      const { sessionID, source, target } = proposal.data
      // The v1 hook does not attest whether a different submitted source effort was selectable or pinned.
      output.decision =
        isRegistered(source) &&
        isRegistered(target) &&
        isQualifiedHop(source, target, false) &&
        canPrepareSession(sessionID)
          ? "allow"
          : "deny"
    },
  }
}
