import { z } from "zod"
import { captureMessages, createSession, requireProof, settle, toolsIn } from "./v2-native-fills-contract"
import type { ScenarioHost } from "./v2-native-fills-contract"

export async function permissionScenario(host: ScenarioHost) {
  const fixture = host.fixtures
  requireProof(fixture.scenario === "permission", "Permission fixture must be prepared before starting the engine")
  const { name, marker } = fixture
  const cases = []
  for (const decision of ["once", "reject"] as const) {
    let called = false
    host.script((request) => {
      requireProof(request.tools?.some((tool) => tool.function.name === "skill"), "Actual OMO skill tool is absent from provider tools")
      if (called) return { text: "Permission scenario concluded." }
      called = true
      return { call: { name: "skill", args: { name } } }
    })
    const sessionID = await createSession(host, [
      { action: "*", resource: "*", effect: "allow" }, { action: "skill", resource: name, effect: "ask" },
    ])
    const after = host.events.length
    const asked = host.waitEvent((event) => event.type === "permission.asked" && event.data["sessionID"] === sessionID && event.data["action"] === "skill", after)
    void asked.catch(() => undefined)
    await host.api(`/api/session/${sessionID}/prompt`, { text: `Load the project skill ${name} once.` })
    const event = await asked
    const pending = z.object({ data: z.array(z.object({ id: z.string(), action: z.string(), resources: z.array(z.string()), source: z.object({ type: z.literal("tool"), id: z.string(), messageID: z.string() }) })) }).parse(await host.api(`/api/session/${sessionID}/permission`))
    const request = pending.data.find((entry) => entry.action === "skill" && entry.resources.includes(name))
    requireProof(request, "Observed native permission ask has no pending skill request")
    const before = await captureMessages(host, sessionID, `permission-${decision}-pending.json`)
    requireProof(!JSON.stringify(before).includes(marker), "Skill body leaked before permission was answered")
    const finished = host.waitEvent((entry) => entry.data["sessionID"] === sessionID && entry.data["id"] === request.source.id && entry.type === (decision === "once" ? "session.tool.success" : "session.tool.failed"), after)
    void finished.catch(() => undefined)
    await host.api(`/api/session/${sessionID}/permission/${request.id}/reply`, { decision })
    await finished
    await settle(host, sessionID)
    const messages = await captureMessages(host, sessionID, `permission-${decision}-messages.json`)
    requireProof(messages.flatMap((message) => message.content ?? []).filter((part) => part.type === "tool").length === 1, "Permission fixture invoked an unexpected tool with a possible side effect")
    const tool = toolsIn(messages, "skill").find((part) => part.id === request.source.id)
    requireProof(tool?.state?.status === (decision === "once" ? "completed" : "error"), `Skill terminal state did not match permission ${decision}`)
    const delivered = JSON.stringify(tool.state.content ?? null).includes(marker)
    requireProof(delivered === (decision === "once"), "Permission outcome did not control access to the real skill body")
    if (decision === "reject") requireProof(!JSON.stringify(messages).includes(marker), "Denied skill body reached session history")
    cases.push({ decision, sessionID, requestID: request.id, source: request.source, event, status: tool.state.status, skillBodyDelivered: delivered })
  }
  host.save("permission-results.json", cases)
  return { cases, noSideEffect: "Denied skill produced no skill-body content; no write tool was invoked" }
}
