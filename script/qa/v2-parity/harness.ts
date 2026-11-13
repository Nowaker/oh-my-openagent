import assert from "node:assert/strict"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { z } from "zod"
import type { Engine, Harness, NativeEvent, ParityContext, ScenarioOptions } from "./contracts"
import { createScriptedProvider } from "./provider"

export async function loadHarness(toolsDirectory: string): Promise<Harness> {
  const module = (name: string) => pathToFileURL(join(toolsDirectory, "_lib/opencode-v2-probe", name)).href
  const isolation: Pick<Harness, "createSandbox" | "assertInside"> = await import(module("isolation.ts"))
  const engine: Pick<Harness, "startEngine" | "request" | "execute" | "within"> = await import(module("engine.ts"))
  const events: Pick<Harness, "subscribeEvent"> = await import(module("events.ts"))
  const runner: Pick<Harness, "runChecks"> = await import(module("runner.ts"))
  const artifacts: Pick<Harness, "createRunRoot" | "settleRunArtifacts" | "completeRun"> = await import(module("artifacts.ts"))
  const render: Pick<Harness, "renderProbeReport"> = await import(module("render.ts"))
  return { ...isolation, ...engine, ...events, ...runner, ...artifacts, ...render }
}

const inventorySchema = z.object({ data: z.array(z.looseObject({
  id: z.string().optional(), state: z.object({ status: z.string() }),
  source: z.object({ type: z.string(), path: z.string().optional() }).optional(),
})) })
const agents = ["sisyphus", "hephaestus", "prometheus", "atlas", "sisyphus-junior", "oracle", "librarian", "explore", "metis", "momus", "multimodal-looker"] as const

export async function createScenarioHost(context: ParityContext, options: ScenarioOptions) {
  const { harness } = context
  const sandbox = harness.createSandbox(context, options.id)
  const provider = createScriptedProvider(options.handler)
  let engine: Engine | undefined
  const dispose = async () => {
    const results = await Promise.allSettled([engine?.stop(), provider[Symbol.asyncDispose]()])
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
    if (failures.length > 0) throw new AggregateError(failures, "Parity scenario cleanup failed")
  }
  try {
    const pluginDirectory = join(sandbox.root, "omo-plugin")
    mkdirSync(pluginDirectory)
    writeFileSync(join(pluginDirectory, "package.json"), JSON.stringify({ name: "omo-parity-fixture", type: "module", exports: { "./server": "./server.ts" } }))
    writeFileSync(join(pluginDirectory, "server.ts"), `export { default } from ${JSON.stringify(pathToFileURL(context.pluginBundle).href)}\n`)
    sandbox.env["OMO_DISABLE_POSTHOG"] = "1"
    sandbox.env["OMO_DISABLE_PROCESS_CLEANUP"] = "1"
    const omoHome = join(sandbox.home, ".omo")
    mkdirSync(omoHome)
    writeFileSync(join(omoHome, "omo.jsonc"), JSON.stringify({ "[opencode]": {
      telemetry: false,
      agents: Object.fromEntries(agents.map((name) => [name, { model: name === "hephaestus" ? "fake/gpt-6.1-sol" : "fake/fake-model" }])),
      disabled_hooks: ["native-edition-nudge", "auto-update-checker", "hephaestus-agents-md-injector", "ast-grep-sg-provision"],
      disabled_mcps: ["context7", "grep_app", "websearch", "lsp"],
      experimental: { disable_live_parent_wake_routing: true },
      claude_code: { mcp: false, commands: false, skills: false, agents: false, hooks: false, plugins: false },
      ...options.omo,
    } }))
    writeFileSync(join(sandbox.config, "opencode.json"), JSON.stringify({
      model: "fake/fake-model", plugins: [pluginDirectory],
      providers: { fake: {
        name: "Parity fixture", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: provider.url, apiKey: "fixture-only" },
        models: Object.fromEntries(["fake-model", "gpt-6.1-sol"].map((name) => [name, { name, capabilities: { tools: true }, limit: { context: 200000, output: 8000 } }])),
      } },
      experimental: { todo: true }, ...options.opencode,
    }))
    await options.prepare?.(sandbox)
    engine = await harness.startEngine(context, sandbox)
    const running = engine
    await using activation = await harness.subscribeEvent(context, running, (event) => event.type === "plugin.updated" && event.location?.directory === sandbox.project)
    await harness.request(running, "/api/plugin")
    await activation.result
    const inventory = await harness.request(running, "/api/plugin")
    assert.equal(inventory.status, 200, "OMO inventory request failed")
    writeFileSync(join(sandbox.root, "plugin-inventory.json"), JSON.stringify(inventory.body, null, 2))
    const plugins = inventorySchema.parse(inventory.body).data
    const plugin = plugins.find((entry) => entry.id === "oh-my-openagent")
    assert.equal(plugin?.state.status, "active", `OMO bridge was not active; inventory ${JSON.stringify(plugins.map(({ id, state, source }) => ({ id, status: state.status, source })))}; artifact ${join(sandbox.root, "plugin-inventory.json")}`)
    const infoResponse = await harness.request(running, "/api/info")
    const info = z.object({ version: z.string(), pid: z.number(), capabilities: z.record(z.string(), z.boolean()).optional() }).parse(infoResponse.body)
    assert.equal(infoResponse.status, 200, "Native engine info request failed")
    assert.equal(info.pid, running.process.pid, "Native engine info belongs to another process")
    assert.equal(info.version.replace(/^(?:opencode\s+)?v?/, ""), context.version.replace(/^(?:opencode\s+)?v?/, ""), "Native executable changed after parity preflight")
    writeFileSync(join(sandbox.root, "engine-info.json"), JSON.stringify(info, null, 2))
    return {
      sandbox, engine: running, provider, pluginDirectory, info,
      request: (path: string, input?: Parameters<Harness["request"]>[2]) => harness.request(running, path, input),
      subscribe: (predicate: (event: NativeEvent) => boolean) => harness.subscribeEvent(context, running, predicate),
      submittedTools() {
        const log = readFileSync(join(sandbox.env.TMPDIR, "oh-my-opencode.log"), "utf8")
        return [...new Set([...log.matchAll(/tool definitions submitted (\{[^\n]+\})/g)].flatMap((match) => z.object({ names: z.array(z.string()) }).parse(JSON.parse(match[1] ?? "")).names))]
      },
      async [Symbol.asyncDispose]() { await dispose() },
    }
  } catch (error) {
    try { await dispose() }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Parity scenario setup and cleanup failed") }
    throw error
  }
}

export type ScenarioHost = Awaited<ReturnType<typeof createScenarioHost>>
