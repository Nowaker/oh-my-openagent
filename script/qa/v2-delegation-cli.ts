import { mkdirSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { z } from "zod"
import type { ParityContext } from "./v2-parity/contracts"
import { createDelegationProbes } from "./v2-delegation/scenarios"
import { createDelegationPermissionProbes } from "./v2-delegation/permission-scenario"
import { createSelectionProbe } from "./v2-delegation/selection"
import { loadHarness, createScenarioHost } from "./v2-parity/harness"

const [root, binary, pluginBundle, toolsDirectory] = z.tuple([z.string(), z.string(), z.string(), z.string()]).parse(process.argv.slice(2, 6)).map((path) => resolve(path))
const mode = z.literal("bridge").parse(process.argv[6] ?? "bridge")
if (!root || !binary || !pluginBundle || !toolsDirectory) throw new TypeError("Expected root, binary, plugin bundle and tools directory")
mkdirSync(root, { recursive: true })
const harness = await loadHarness(toolsDirectory)
const versionSandbox = harness.createSandbox({ root }, "version")
const identification = await harness.execute({ binary, signal: AbortSignal.timeout(30000) }, versionSandbox, { args: ["--version"] })
if (identification.code !== 0) throw new TypeError("Cannot identify the requested v2 binary")
const version = identification.stdout.trim()
const controller = new AbortController()
const abort = () => controller.abort(new DOMException("Delegation QA interrupted", "AbortError"))
process.once("SIGINT", abort)
process.once("SIGTERM", abort)
const timer = setTimeout(abort, 240000)
try {
  const context: ParityContext = { binary, root, version, signal: controller.signal, toolsDirectory, pluginBundle, sourceDirectory: process.cwd(), harness }
  const probes = [...createDelegationProbes(createScenarioHost, mode), ...createDelegationPermissionProbes(createScenarioHost), createSelectionProbe(createScenarioHost)]
  const selected = process.argv[7] ? probes.filter((probe) => probe.id === process.argv[7]) : probes
  if (selected.length === 0) throw new TypeError(`Unknown ${mode} delegation probe: ${process.argv[7]}`)
  const results = await harness.runChecks(context, selected.map((probe) => ({ ...probe, run: () => probe.run(context) })))
  const report = { binary, root, version, results, ok: results.every((result) => result.status === "pass") }
  writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.ok ? 0 : 1
} finally {
  clearTimeout(timer)
  process.removeListener("SIGINT", abort)
  process.removeListener("SIGTERM", abort)
}
