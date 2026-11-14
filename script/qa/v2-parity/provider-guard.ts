import { appendFileSync } from "node:fs"
import type { Plugin } from "@opencode/plugin"

type Stage = "agent" | "model" | "http" | "websocket"

export class ProbeProviderRefused extends Error {
  constructor(readonly stage: Stage, readonly providerID: string, readonly host?: string) {
    super(`Probe provider refused at ${stage}: provider=${providerID}${host ? ` host=${host}` : ""}`)
    this.name = "ProbeProviderRefused"
  }
}

export async function installProviderGuard(ctx: Plugin.Context, input: {
  readonly origin: string; readonly logFile: string;
}): Promise<Plugin.Cleanup> {
  const expected = new URL(input.origin)
  if (expected.protocol !== "http:" || expected.hostname !== "127.0.0.1") throw new ProbeProviderRefused("http", "fixture", expected.hostname)
  const registrations: { readonly dispose: () => Promise<void> }[] = []
  const inspect = (stage: Stage, model: { readonly providerID: string; readonly id: string }, endpoint?: string) => {
    const url = endpoint && URL.canParse(endpoint) ? new URL(endpoint) : undefined
    const allowed = model.providerID === "fake" && stage !== "websocket" && (endpoint === undefined || url?.origin === expected.origin)
    appendFileSync(input.logFile, JSON.stringify({ stage, providerID: model.providerID, modelID: model.id, host: url?.hostname, allowed }) + "\n")
    if (!allowed) throw new ProbeProviderRefused(stage, model.providerID, url?.hostname)
  }
  const dispose = async () => {
    const results = await Promise.allSettled(registrations.splice(0).map((registration) => registration.dispose()))
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, "Probe provider guard cleanup failed")
  }
  try {
    registrations.push(await ctx.session.hook("model.request", async (event) => {
      const agent = (await ctx.agent.list()).data.find((entry) => entry.id === event.agent)
      if (agent?.model?.providerID !== "fake") {
        appendFileSync(input.logFile, JSON.stringify({ stage: "agent", agentID: event.agent, providerID: agent?.model?.providerID ?? null, allowed: false }) + "\n")
        throw new ProbeProviderRefused("agent", event.model.providerID)
      }
      inspect("model", event.model, event.baseURL)
    }))
    registrations.push(await ctx.session.hook("http.request", (event) => inspect("http", event.model, event.request.url)))
    registrations.push(await ctx.session.hook("experimental.ws.handshake", (event) => inspect("websocket", event.model, event.url)))
    return dispose
  } catch (error) {
    try { await dispose() }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Probe provider guard setup failed") }
    throw error
  }
}
