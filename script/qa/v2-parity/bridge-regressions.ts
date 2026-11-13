import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import type { ParityContext, ParityProbe } from "./contracts"
import { createScenarioHost } from "./harness"
import type { ProviderHandler } from "./provider"

const sessionSchema = z.object({ data: z.object({ id: z.string() }) })
const eventSession = z.object({ sessionID: z.string() })
const messagesSchema = z.object({ data: z.array(z.looseObject({ content: z.array(z.looseObject({
  type: z.string(), name: z.string().optional(), state: z.looseObject({ status: z.string(), content: z.json().optional() }).optional(),
})).optional() })) })
const pluginSchema = z.object({ data: z.array(z.object({ id: z.string().optional(), state: z.object({ status: z.string() }),
  source: z.object({ type: z.string(), path: z.string().optional() }),
})) })
const missingTask = "parity-bridge-no-task"
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex")

function provenance(context: ParityContext) {
  return { binaryVersion: context.version, bundleSha256: sha256(context.pluginBundle),
    currentBridgeSourceSha256: sha256(join(context.sourceDirectory, "packages/omo-opencode/src/plugin-v2/tool-bridge-register.ts")),
    sourceBinding: context.pluginBundle === join(context.sourceDirectory, "dist/index.js") ? "current-worktree-build" : "external-bundle-source-commit-unasserted" }
}

async function toolTurn(context: ParityContext, spec: { readonly id: string; readonly glob: boolean }) {
  let project = ""
  const handler: ProviderHandler = (request) => {
    const names = (request.tools ?? []).map((tool) => tool.function.name)
    const completed = request.messages.filter((message) => message.role === "tool").length
    if (spec.glob && completed === 0 && names.includes("glob")) return { kind: "tools", calls: [
      { id: "call_parity_glob", name: "glob", args: { pattern: "*.txt", path: project } },
    ] }
    if (names.includes("background_output") && completed < (spec.glob ? 2 : 1)) return { kind: "tools", calls: [
      { id: "call_parity_omo", name: "background_output", args: { task_id: missingTask, block: false } },
    ] }
    return { kind: "text", text: "Bridge fixture turn ended." }
  }
  await using host = await createScenarioHost(context, { id: spec.id, handler,
    prepare(sandbox) { project = sandbox.project; writeFileSync(join(project, "bridge-demo.txt"), "OMO bridge parity fixture\n") },
  })
  const created = await host.request("/api/session", { method: "POST", body: { title: spec.id, agent: "sisyphus",
    model: { providerID: "fake", id: "fake-model" }, permissions: [{ action: "*", resource: "*", effect: "allow" }],
  } })
  assert.equal(created.status, 200, "Bridge session creation failed")
  const id = sessionSchema.parse(created.body).data.id
  const events: string[] = []
  await using finished = await host.subscribe((event) => {
    const parsed = eventSession.safeParse(event.data)
    if (!parsed.success || parsed.data.sessionID !== id) return false
    events.push(event.type)
    return event.type === "session.execution.succeeded" || event.type === "session.execution.failed"
  })
  const prompted = await host.request(`/api/session/${id}/prompt`, { method: "POST", body: {
    text: spec.glob ? `List *.txt with glob, then use background_output for missing task ${missingTask}.` : `Use background_output to inspect missing task ${missingTask}.`,
  } })
  assert.equal(prompted.status, 200, "Bridge prompt admission failed")
  const terminal = await finished.result
  const response = await host.request(`/api/session/${id}/message`)
  assert.equal(response.status, 200, "Bridge message read failed")
  const parts = messagesSchema.parse(response.body).data.flatMap((message) => message.content ?? [])
    .filter((part) => part.type === "tool" && part.state?.status === "completed")
  const modelRequests = host.provider.requests.filter((request) => (request.tools?.length ?? 0) > 0)
  const names = [...new Set(modelRequests.flatMap((request) => request.tools ?? []).map((tool) => tool.function.name))].sort()
  const glob = parts.find((part) => part.name === "glob")
  const background = parts.find((part) => part.name === "background_output")
  const globText = JSON.stringify(glob?.state?.content ?? null)
  const backgroundText = JSON.stringify(background?.state?.content ?? null)
  const receipt = { ...provenance(context), sessionID: id, events, terminal: terminal.type,
    providerRequestCount: host.provider.requests.length, modelToolNames: names,
    modelSchemas: modelRequests.flatMap((request) => (request.tools ?? []).filter((tool) => ["glob", "background_output"].includes(tool.function.name))
      .map((tool) => ({ name: tool.function.name, parameters: tool.function["parameters"] }))),
    completedTools: parts.map((part) => ({ name: part.name, state: part.state })),
    nativeGlobWouldLookSuccessful: globText.includes("bridge-demo.txt"), omoGlobResult: globText.includes("Found 1 file(s)"),
    omoOnlyAdmitted: names.includes("background_output"), omoOnlyCompleted: backgroundText.includes(`Task not found: ${missingTask}`),
  }
  writeFileSync(join(host.sandbox.root, "bridge-receipt.json"), JSON.stringify(receipt, null, 2) + "\n")
  assert.equal(terminal.type, "session.execution.succeeded", "Bridge turn failed before regression assertions")
  assert.equal(receipt.omoOnlyAdmitted, true, "OMO-only background_output was not admitted into the model's tool registry; native glob completion cannot prove OMO execution")
  assert.equal(receipt.omoOnlyCompleted, true, "OMO-only background_output did not execute to its missing-task result")
  assert.ok(events.includes("session.tool.success"), "Native session.tool.success was not observed")
  if (spec.glob) {
    assert.equal(receipt.nativeGlobWouldLookSuccessful, true, "Glob did not return the fixture filename")
    assert.equal(receipt.omoGlobResult, true, "Glob returned a native result instead of the OMO implementation")
  } else {
    const submitted = host.submittedTools()
    assert.ok(submitted.includes("background_output"), "OMO setup did not submit its distinctive tool")
    const missing = submitted.filter((name) => !names.includes(name))
    assert.deepEqual(missing, [], "OMO tool schemas were submitted but skipped by native admission (seen.ref/codemode regression)")
    writeFileSync(join(host.sandbox.root, "admission-receipt.json"), JSON.stringify({ submitted, admitted: names, missing }, null, 2) + "\n")
  }
  return { status: "pass" as const, detail: `${modelRequests.length} model requests; OMO-only handler completed; ${spec.glob ? "OMO glob result distinguishes native false positives" : "all submitted schemas admitted as direct tools (seen.ref and codemode:false)"}` }
}

export const bridgeRegressionProbes: readonly ParityProbe[] = [
  { id: "bridge-schema-codemode", label: "seen.ref admission and codemode:false direct execution",
    run: (context) => toolTurn(context, { id: "bridge-schema-codemode", glob: false }) },
  { id: "bridge-directory-loading", label: "Actual OMO directory wrapper executes setup",
    async run(context) {
      await using host = await createScenarioHost(context, { id: "bridge-directory-loading", handler: () => ({ kind: "text", text: "unused" }) })
      const inventory = await host.request("/api/plugin")
      assert.equal(inventory.status, 200)
      const plugin = pluginSchema.parse(inventory.body).data.find((entry) => entry.id === "oh-my-openagent")
      const submitted = host.submittedTools()
      const receipt = { ...provenance(context), plugin, submitted, providerRequests: host.provider.requests.length }
      writeFileSync(join(host.sandbox.root, "directory-receipt.json"), JSON.stringify(receipt, null, 2) + "\n")
      assert.equal(plugin?.state.status, "active", "OMO directory did not become active")
      assert.equal(plugin?.source.type, "local", "OMO was not loaded from the configured local directory")
      assert.equal(plugin?.source.path, host.pluginDirectory, "OMO inventory points to a different source than the directory wrapper")
      assert.ok(submitted.includes("background_output"), "Actual OMO setup did not submit its tools")
      const fileBox = context.harness.createSandbox(context, "bridge-directory-file-control")
      const entry = join(host.pluginDirectory, "server.ts")
      writeFileSync(join(fileBox.config, "opencode.json"), JSON.stringify({ plugins: [entry] }))
      await using fileEngine = await context.harness.startEngine(context, fileBox)
      await using settled = await context.harness.subscribeEvent(context, fileEngine,
        (event) => event.type === "plugin.updated" && event.location?.directory === fileBox.project)
      await context.harness.request(fileEngine, "/api/plugin")
      await settled.result
      const fileInventory = await context.harness.request(fileEngine, "/api/plugin")
      assert.equal(fileInventory.status, 200)
      const entries = pluginSchema.parse(fileInventory.body).data
      assert.equal(entries.some((candidate) => candidate.id === "oh-my-openagent" || candidate.source.path === entry), false,
        "Configured OMO file was admitted; revisit the current directory-only contract")
      writeFileSync(join(fileBox.root, "configured-file-receipt.json"), JSON.stringify({ ...provenance(context), configuredFile: entry,
        omoPresent: false, directoryControlSubmitted: submitted, providerRequests: host.provider.requests.length }, null, 2) + "\n")
      return { status: "pass", detail: `Actual OMO directory active with ${submitted.length} submitted tools; same OMO file export ignored in a separate engine` }
    } },
  { id: "bridge-native-glob-origin", label: "Native glob completion cannot pass as OMO tool execution",
    run: (context) => toolTurn(context, { id: "bridge-native-glob-origin", glob: true }) },
]
