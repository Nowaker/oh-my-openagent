import assert from "node:assert/strict"
import { join } from "node:path"
import { z } from "zod"
import { defaultModeScenario, instructionsScenario, overflowScenario, permissionScenario, todosScenario, withNativeHost } from "../v2-native-fills"
import type { ScenarioHost } from "../v2-native-fills"
import type { ParityProbe } from "./contracts"

const skipped = z.object({ status: z.literal("skipped"), reason: z.string() })
const engineInfo = z.looseObject({ version: z.string() })
const bareVersion = (version: string) => version.replace(/^(?:opencode\s+)?v?/, "")
const permissionCases = z.looseObject({ cases: z.array(z.looseObject({ sessionID: z.string(), decision: z.string() })) })
const terminalTypes = ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"] as const
const scenarios = [
  ["permission", permissionScenario, "permission.assert allow and deny reach a real OMO skill call"],
  ["todos", todosScenario, "Native todowrite drives idle continuation and the stop command"],
  ["instructions", instructionsScenario, "OMO rules and modes reach the model as native instructions across compaction"],
  ["default-mode", defaultModeScenario, "Configured default mode reaches the model without a keyword"],
  ["overflow", overflowScenario, "Automatic overflow compaction keeps native todos and wakes the session"],
] as const

export const nativeFillProbes: readonly ParityProbe[] = scenarios.map(([scenario, run, label]) => ({
  id: `native-${scenario}`, label,
  async run(context) {
    let captureRoot = ""
    const scratch = context.harness.createSandbox(context, `native-fill-${scenario}`)
    const outcome = await withNativeHost<unknown>({ evidenceRoot: join(context.root, "native-fills"), engineRoot: scratch.scratchRoot, binary: context.binary, plugin: context.pluginBundle, scenario },
      async (host: ScenarioHost) => {
        captureRoot = host.root
        const info = engineInfo.parse(await host.api("/api/info"))
        assert.equal(bareVersion(info.version), bareVersion(context.version), "Native-fill engine differs from the preflighted executable")
        const result = await run(host)
        const balanced = () => {
          const current = host.events.filter((event) => event.type === "session.execution.started" || terminalTypes.some((type) => type === event.type))
          const ids = [...new Set(current.map((event) => String(event.data["sessionID"])))]
          return ids.every((id) => current.filter((event) => event.data["sessionID"] === id && event.type === "session.execution.started").length
            === current.filter((event) => event.data["sessionID"] === id && event.type !== "session.execution.started").length)
        }
        if (!balanced()) await host.waitEvent((event) => terminalTypes.some((type) => type === event.type) && balanced())
        const executions = host.events.filter((event) => event.type === "session.execution.started" || terminalTypes.some((type) => type === event.type))
        const sessions = [...new Set(executions.map((event) => String(event.data["sessionID"])))]
        assert.ok(sessions.length > 0 || skipped.safeParse(result).success, "Native-fill scenario ran no native execution")
        for (const sessionID of sessions) {
          const own = executions.filter((event) => event.data["sessionID"] === sessionID)
          const started = own.filter((event) => event.type === "session.execution.started").length
          const ended = own.filter((event) => event.type !== "session.execution.started")
          assert.equal(ended.length, started, `Native execution of ${sessionID} did not reach a terminal event`)
          assert.ok(!ended.some((event) => event.type === "session.execution.failed"), `Native execution of ${sessionID} failed`)
          const rejected = scenario === "permission" && permissionCases.parse(result).cases.some((entry) => entry.sessionID === sessionID && entry.decision === "reject")
          if (!rejected) assert.ok(ended.every((event) => event.type === "session.execution.succeeded"), `Native execution of ${sessionID} was interrupted`)
        }
        host.save("execution-outcomes.json", sessions.map((sessionID) => ({ sessionID, terminal: executions.filter((event) => event.data["sessionID"] === sessionID && event.type !== "session.execution.started").map((event) => event.type) })))
        return result
      })
    context.signal.throwIfAborted()
    const skip = skipped.safeParse(outcome)
    if (skip.success) return { status: "skip", detail: skip.data.reason }
    return { status: "pass", detail: `W8 ${scenario} scenario passed on the preflighted engine; evidence ${captureRoot}` }
  },
}))
