import type { PluginInput } from "@opencode-ai/plugin"
import { z } from "zod"
import { readBoulderState } from "../boulder-state"

const BindingSchema = z.object({ version: z.literal(1), sessionId: z.string(), machineId: z.string(),
  generation: z.string(), scopeId: z.string() })
const PlanSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("todos"), keys: z.array(z.string()).readonly() }),
  z.object({ kind: z.literal("boulder"), workId: z.string() }),
])
const LeaseSchema = z.object({ binding: BindingSchema, plan: PlanSchema })
type Binding = z.infer<typeof BindingSchema>
export type ContinuationPlan = z.infer<typeof PlanSchema>
type Lease = z.infer<typeof LeaseSchema>
type Bridge = {
  readonly binding: (sessionId: string) => Binding | null
  readonly capture: (sessionId: string, plan: ContinuationPlan) => Lease | null
  readonly validate: (lease: Lease) => boolean
  readonly stop: (sessionId: string) => void
  readonly freshPlan: (sessionId: string, previousWorkId: string | null) => void
}
const BridgeSchema = z.custom<Bridge>(value => value !== null && typeof value === "object" &&
  ["binding", "capture", "validate", "stop", "freshPlan"].every(key => typeof Reflect.get(value, key) === "function"))

export type ContinuationPermit = { readonly kind: "native" }
  | { readonly kind: "scoped"; readonly lease: Lease }

export function continuationBridge(): Bridge | null {
  const parsed = BridgeSchema.safeParse(Reflect.get(globalThis, "__vibetermContinuationAuthorityV1"))
  return parsed.success ? parsed.data : null
}

export function authorizeBoulderPlan(directory: string, trackedSessionId: string): void {
  const bridge = continuationBridge()
  const workId = readBoulderState(directory)?.active_work_id
  if (!bridge || !workId) return
  const sessionID = trackedSessionId.startsWith("opencode:") ? trackedSessionId.slice("opencode:".length) : trackedSessionId
  bridge.freshPlan(sessionID, null)
  bridge.capture(sessionID, { kind: "boulder", workId })
}

export async function captureContinuationPermit(ctx: PluginInput, sessionID: string,
  plan: ContinuationPlan): Promise<ContinuationPermit | null> {
  const bridge = continuationBridge()
  if (bridge) {
    try {
      const lease = LeaseSchema.safeParse(bridge.capture(sessionID, plan))
      return lease.success && lease.data.binding.sessionId === sessionID &&
        (!process.env.VIBETERM_MACHINE_ID || lease.data.binding.machineId === process.env.VIBETERM_MACHINE_ID)
        ? { kind: "scoped", lease: lease.data } : null
    } catch { return null }
  }
  if (process.env.VIBETERM_MACHINE_ID) return null
  if (typeof ctx.client.session.get === "function") {
    try {
      const response = await ctx.client.session.get({ path: { id: sessionID } })
      const record = z.object({ data: z.object({ metadata: z.record(z.string(), z.unknown()).optional() }) })
        .safeParse(response)
      if (!record.success) return null
      const metadata = record.data.data.metadata?.vibeterm
      if (metadata !== null && typeof metadata === "object" && Object.hasOwn(metadata, "continuationAuthority")) return null
    } catch { return null }
  }
  return { kind: "native" }
}

export async function continuationPermitCurrent(ctx: PluginInput, sessionID: string,
  permit: ContinuationPermit): Promise<boolean> {
  switch (permit.kind) {
    case "native": return (await captureContinuationPermit(ctx, sessionID, { kind: "todos", keys: [] }))?.kind === "native"
    case "scoped": {
      const bridge = continuationBridge()
      if (!bridge || !bridge.validate(permit.lease)) return false
      let currentPlan: ContinuationPlan
      switch (permit.lease.plan.kind) {
        case "todos": {
          const response = await ctx.client.session.todo({ path: { id: sessionID } })
          const parsed = z.object({ data: z.array(z.object({ content: z.string(), status: z.string() })) }).safeParse(response)
          if (!parsed.success) return false
          currentPlan = { kind: "todos", keys: parsed.data.data.filter(todo =>
            todo.status !== "completed" && todo.status !== "cancelled").map(todo => todo.content).sort() }
          break
        }
        case "boulder": {
          const boulder = readBoulderState(ctx.directory)
          if (!boulder?.active_work_id) return false
          currentPlan = { kind: "boulder", workId: boulder.active_work_id }
          break
        }
      }
      const current = bridge.capture(sessionID, currentPlan)
      return current !== null && bridge.validate(permit.lease) &&
        JSON.stringify(current.plan) === JSON.stringify(permit.lease.plan)
    }
  }
}
