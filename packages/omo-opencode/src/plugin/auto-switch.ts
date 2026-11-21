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

function isPhaseOneSwitch(source: Route, target: Route): boolean {
  return (
    getAgentConfigKey(source.agent) === "sisyphus" &&
    source.providerID === "anthropic" &&
    source.modelID === "claude-opus-5-5" &&
    source.variant === "high" &&
    getAgentConfigKey(target.agent) === "hephaestus" &&
    target.providerID === "openai" &&
    target.modelID === "gpt-6.2-sol" &&
    target.variant === "xhigh"
  )
}

export function readEffectiveAutoSwitchRoute(input: unknown): Route | undefined {
  const hookInput = contextInputSchema.safeParse(input)
  if (!hookInput.success) return undefined
  const { preferred, effective } = hookInput.data.autoSwitch
  return isPhaseOneSwitch(preferred, effective) ? effective : undefined
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
      output.decision =
        isRegistered(source) && isRegistered(target) && isPhaseOneSwitch(source, target) && canPrepareSession(sessionID)
          ? "allow"
          : "deny"
    },
  }
}
