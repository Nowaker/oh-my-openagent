import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { requestContainsInstruction } from "../v2-native-fills-contract"
import type { ParityContext, ParityProbe } from "./contracts"
import { createScenarioHost } from "./harness"

const sessionSchema = z.object({ data: z.object({ id: z.string() }) })
const eventSession = z.object({ sessionID: z.string() })
const contentSchema = z.union([z.string(), z.array(z.looseObject({ text: z.string().optional() }))])
const entriesSchema = z.object({ data: z.array(z.object({ key: z.string(), value: z.unknown() })) })
const modes = [
  { type: "ultrawork", trigger: "ultrawork" },
  { type: "team", trigger: "team mode" },
  { type: "hyperplan", trigger: "hyperplan" },
  { type: "hyperplan-ultrawork", trigger: "hyperplan ultrawork" },
] as const
type Mode = (typeof modes)[number]

async function expansion(context: ParityContext, input: { readonly mode: Mode; readonly enabled: boolean; readonly text: string; readonly token: string }) {
  const id = `keyword-${input.mode.type}-${input.enabled ? "enabled" : "disabled"}`
  await using host = await createScenarioHost(context, { id, handler: () => ({ kind: "text", text: "Fixture acknowledged." }),
    omo: { keyword_detector: { enabled_expansions: input.enabled ? [input.mode.type] : [] } },
  })
  const created = await host.request("/api/session", { method: "POST", body: { agent: "sisyphus", title: id,
    model: { providerID: "fake", id: "fake-model" },
    permissions: [{ action: "*", resource: "*", effect: "allow" }] } })
  assert.equal(created.status, 200, "Keyword session creation failed")
  const sessionID = sessionSchema.parse(created.body).data.id
  const events: string[] = []
  await using finished = await host.subscribe((event) => {
    const parsed = eventSession.safeParse(event.data)
    if (!parsed.success || parsed.data.sessionID !== sessionID) return false
    events.push(event.type)
    return event.type === "session.execution.succeeded" || event.type === "session.execution.failed"
  })
  const prompted = await host.request(`/api/session/${sessionID}/prompt`, { method: "POST", body: { text: input.text } })
  writeFileSync(join(host.sandbox.root, "admission.json"), JSON.stringify({ sessionID, response: prompted }, null, 2) + "\n")
  assert.equal(prompted.status, 200, `Keyword prompt admission failed: ${JSON.stringify(prompted.body)}`)
  const terminal = await finished.result
  const delivered = host.provider.requests.flatMap((request) => request.messages.filter((message) => message.role === "user").map((message) => {
    const content = contentSchema.parse(message.content)
    return typeof content === "string" ? content : content.map((part) => part.text ?? "").join("\n")
  })).find((text) => text.includes(input.token))
  writeFileSync(join(host.sandbox.root, "keyword-receipt.json"), JSON.stringify({ engine: host.info, binaryVersion: context.version,
    sessionID, mode: input.mode.type, enabled: input.enabled, events, terminal: terminal.type, providerRequests: host.provider.requests.length,
    input: input.text, deliveredSha256: delivered === undefined ? null : createHash("sha256").update(delivered).digest("hex"),
    inputPreserved: delivered?.startsWith(input.text) ?? false, changed: delivered !== undefined && delivered !== input.text,
    deliveredBytes: delivered === undefined ? null : Buffer.byteLength(delivered) }, null, 2) + "\n")
  assert.equal(terminal.type, "session.execution.succeeded", "Keyword native turn failed")
  assert.ok(delivered, "Dynamic keyword input never reached provider user messages")
  const entries = await host.request(`/api/experimental/session/${sessionID}/instructions/entries`)
  assert.equal(entries.status, 200, "Native instruction entries request failed")
  const mode = entriesSchema.parse(entries.body).data.find((entry) => entry.key === "omo-mode")?.value
  const guidance = typeof mode === "string" && mode.length > 0 ? mode : undefined
  const reachedModel = guidance !== undefined && host.provider.requests.some((request) => requestContainsInstruction(request, guidance))
  writeFileSync(join(host.sandbox.root, "keyword-instructions.json"), JSON.stringify({ sessionID, modeEntryPresent: mode !== undefined,
    guidanceBytes: guidance === undefined ? null : Buffer.byteLength(guidance), reachedModel }, null, 2) + "\n")
  return { delivered, guidance, reachedModel }
}

async function keyword(context: ParityContext, mode: Mode) {
  const token = `keyword-input-${randomUUID()}`
  const text = `Inspect fixture ${token}. Requested mode: ${mode.trigger}.`
  const disabled = await expansion(context, { mode, enabled: false, text, token })
  assert.equal(disabled.delivered, text, "Disabled keyword mode changed the provider user message")
  assert.equal(disabled.guidance, undefined, "Disabled keyword mode still created its native omo-mode instruction")
  const enabled = await expansion(context, { mode, enabled: true, text, token })
  assert.equal(enabled.delivered, text, "Enabled keyword mode rewrote the user message instead of using a native instruction")
  assert.ok(enabled.guidance, "Enabled keyword mode created no native omo-mode instruction")
  assert.equal(enabled.reachedModel, true, "Native omo-mode instruction never reached the provider request")
  return { status: "pass" as const, detail: `${mode.type} created a native omo-mode instruction that reached the provider only when enabled; the user message stayed verbatim in both runs; no authored wording asserted` }
}

export const keywordModeProbes: readonly ParityProbe[] = modes.map((mode) => ({ id: `keyword-${mode.type}`,
  label: `${mode.type} expansion reaches the provider and obeys its enablement`, run: (context: ParityContext) => keyword(context, mode) }))
