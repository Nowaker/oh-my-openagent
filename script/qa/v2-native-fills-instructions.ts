import { z } from "zod"
import { captureMessages, createSession, isTodoContinuation, modelRequestText, requestContainsInstruction, requireProof, settle } from "./v2-native-fills-contract"
import type { ProviderReply, ScenarioHost } from "./v2-native-fills-contract"

const entries = z.object({ data: z.array(z.object({ key: z.string(), value: z.unknown() })) })

export async function instructionsScenario(host: ScenarioHost) {
  const fixture = host.fixtures
  requireProof(fixture.scenario === "instructions", "Rule fixture must be prepared before starting the engine")
  const { marker } = fixture
  const sessionID = await createSession(host)
  let read = false
  let manualBoundary: number | undefined
  let summaryRequests = 0
  let mainRequests = 0
  let modeRequested = false
  let checkpointTodoWritten = false
  host.script(async (request): Promise<ProviderReply> => {
    if (manualBoundary !== undefined && summaryRequests === 0) {
      await host.waitEvent((event) => event.type === "session.compaction.started" && event.data["sessionID"] === sessionID && event.data["reason"] === "manual", manualBoundary)
      summaryRequests++
      return { text: "## Objective\nInspect the native fixture.\n\n## Work State\nThe fixture was inspected.\n\n## Next Move\nContinue the fixture analysis with its applicable instructions." }
    }
    if (!request.tools?.length) return { text: "Native instructions fixture." }
    mainRequests++
    if (!read) {
      read = true
      requireProof(request.tools.some((tool) => tool.function.name === "read"), "Native read is unavailable")
      return { call: { name: "read", args: { path: fixture.path } } }
    }
    if (modeRequested && !checkpointTodoWritten) {
      checkpointTodoWritten = true
      return { call: { name: "todowrite", args: { todos: [{ content: fixture.compactionMarker, status: "completed" }] } } }
    }
    return { text: "Fixture analysis is recorded." }
  })
  await host.api(`/api/session/${sessionID}/prompt`, { text: "Read native-fixture.ts with the read tool and report its value." })
  await settle(host, sessionID)
  const afterRead = entries.parse(await host.api(`/api/experimental/session/${sessionID}/instructions/entries`))
  host.save("instructions-after-read.json", afterRead)
  const rule = afterRead.data.find((entry) => entry.key.startsWith("omo-rules-") && JSON.stringify(entry.value).includes(marker))
  requireProof(rule, "Reading the matching fixture did not create an OMO rule instruction entry")
  requireProof(host.requests.some((request) => JSON.stringify(request.messages).includes(marker)), "Dynamic rule fixture did not reach provider input after the read")
  modeRequested = true
  await host.api(`/api/session/${sessionID}/prompt`, { text: "ultrawork: analyze the native fixture you just read." })
  await settle(host, sessionID)
  const afterMode = entries.parse(await host.api(`/api/experimental/session/${sessionID}/instructions/entries`))
  host.save("instructions-after-mode.json", afterMode)
  const mode = afterMode.data.find((entry) => entry.key === "omo-mode")
  requireProof(mode && typeof mode.value === "string" && mode.value.length > 0, "Explicit mode trigger did not create omo-mode")
  const modeText = mode.value
  requireProof(host.requests.some((request) => requestContainsInstruction(request, modeText)), "Mode instruction entry did not reach actual model input")
  const after = host.events.length
  const completed = host.waitEvent((event) => event.type === "session.compaction.ended" && event.data["sessionID"] === sessionID && event.data["reason"] === "manual", after)
  void completed.catch(() => undefined)
  manualBoundary = after
  const beforeManual = mainRequests
  await host.api(`/api/session/${sessionID}/compact`, {})
  await completed
  await settle(host, sessionID)
  requireProof(summaryRequests === 1, "Manual compaction did not reach the model exactly once")
  requireProof(mainRequests === beforeManual, "Manual compaction unexpectedly resumed ordinary model work")
  requireProof(!host.events.slice(after).some((event) => isTodoContinuation(event, sessionID)), "Manual compaction unexpectedly injected an idle continuation")
  const afterCompact = entries.parse(await host.api(`/api/experimental/session/${sessionID}/instructions/entries`))
  host.save("instructions-after-compact.json", afterCompact)
  const snapshot = afterCompact.data.find((entry) => entry.key === "omo-compaction-context")
  requireProof(snapshot && JSON.stringify(snapshot.value).includes(fixture.compactionMarker), "Compaction did not persist its native todo snapshot as an instruction entry")
  const requestBoundary = host.requests.length
  await host.api(`/api/session/${sessionID}/prompt`, { text: "Continue the fixture analysis after the requested compaction." })
  await settle(host, sessionID)
  const requests = host.requests.slice(requestBoundary)
  requireProof(requests.some((request) => JSON.stringify(request.messages).includes(marker)), "Dynamic rule instruction was lost from post-compaction model input")
  requireProof(requests.some((request) => requestContainsInstruction(request, modeText)), "Mode entry was lost from post-compaction model input")
  requireProof(requests.some((request) => modelRequestText(request).includes(fixture.compactionMarker)), "Compaction context snapshot did not reach the next model request")
  await captureMessages(host, sessionID, "instructions-messages.json")
  return { sessionID, marker, compactionMarker: fixture.compactionMarker, ruleKey: rule.key, modeKey: mode.key, entryKeys: afterCompact.data.map((entry) => entry.key), manualCompactionAutoResumed: false, manualCompactionRequiresNextPrompt: true, postCompactionModelInputVerified: true }
}
