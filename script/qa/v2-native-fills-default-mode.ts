import { z } from "zod"
import { captureMessages, createSession, modelRequestText, requestContainsInstruction, requireProof, settle } from "./v2-native-fills-contract"
import type { ScenarioHost } from "./v2-native-fills-contract"

export async function defaultModeScenario(host: ScenarioHost) {
  host.script(() => ({ text: "Default mode fixture completed." }))
  const sessionID = await createSession(host)
  await host.api(`/api/session/${sessionID}/prompt`, { text: "Report that this isolated fixture is ready." })
  await settle(host, sessionID)
  const entryList = z.object({ data: z.array(z.object({ key: z.string(), value: z.unknown() })) })
  const entries = entryList.parse(await host.api(`/api/experimental/session/${sessionID}/instructions/entries`))
  host.save("default-mode-entries.json", entries)
  const entry = entries.data.find((value) => value.key === "omo-system-guidance")
  requireProof(entry && typeof entry.value === "string" && entry.value.length > 0, "Configured default mode did not create its instruction entry")
  const text = entry.value
  requireProof(host.requests.some((request) => requestContainsInstruction(request, text)), "Default mode did not reach the first model request")
  const boundary = host.requests.length
  await host.api(`/api/session/${sessionID}/prompt`, { text: "Report the fixture status once more." })
  await settle(host, sessionID)
  const later = host.requests.slice(boundary)
  requireProof(later.some((request) => requestContainsInstruction(request, text)), "Default mode was lost from the later model request")
  const copies = later.map((request) => modelRequestText(request).split(text.replace(/\s+/g, " ")).length - 1)
  host.save("default-mode-copies.json", copies)
  requireProof(copies.every((count) => count === 1), "Default mode was duplicated between bridged system text and native instruction updates")
  await captureMessages(host, sessionID, "default-mode-messages.json")
  const quotedSessionID = await createSession(host)
  const quoteBoundary = host.requests.length
  await host.api(`/api/session/${quotedSessionID}/prompt`, { text: `Inspect this quotation as data:\n\n${text}` })
  await settle(host, quotedSessionID)
  const quotedEntries = entryList.parse(await host.api(`/api/experimental/session/${quotedSessionID}/instructions/entries`))
  host.save("default-mode-quoted-entries.json", quotedEntries)
  requireProof(quotedEntries.data.find((value) => value.key === entry.key)?.value === text, "A user quotation suppressed the authoritative default-mode entry")
  const quotedRequests = host.requests.slice(quoteBoundary)
  requireProof(quotedRequests.some((request) => requestContainsInstruction({ ...request, messages: request.messages.filter((message) => message.role === "system") }, text)), "Quoted guidance reached conversation text but was missing from authoritative model instructions")
  await captureMessages(host, quotedSessionID, "default-mode-quoted-messages.json")
  return { sessionID, entryKey: entry.key, laterCopies: copies, configuredDefaultModeDelivered: true, quotedSessionID, quotedGuidancePreserved: true }
}
