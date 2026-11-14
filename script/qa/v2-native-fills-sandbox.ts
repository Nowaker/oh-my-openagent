import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { requireProof } from "./v2-native-fills-contract"
import type { DriverOptions } from "./v2-native-fills-contract"

export function createSandbox(options: DriverOptions) {
  const evidence = resolve(options.evidenceRoot)
  mkdirSync(evidence, { recursive: true })
  const root = mkdtempSync(join(realpathSync(evidence), `${options.scenario}-`))
  const scratchRoot = options.engineRoot ?? root
  const binary = realpathSync(options.binary)
  const plugin = realpathSync(options.plugin)
  accessSync(binary, constants.X_OK)
  accessSync(plugin, constants.R_OK)
  for (const part of ["home/project", "config/opencode", "data", "state", "cache", "tmp", "tools", "plugins", "runtime", "home/.omo"]) mkdirSync(join(scratchRoot, part), { recursive: true })
  mkdirSync(join(root, "plugin"))
  const home = realpathSync(join(scratchRoot, "home"))
  const project = realpathSync(join(home, "project"))
  for (let current = project; ; current = dirname(current)) {
    const path = relative(scratchRoot, current)
    requireProof(path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path), "Project config walk escaped the scratch root")
    if (current === home) break
    requireProof(dirname(current) !== current, "Scratch HOME must enclose the project")
  }
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: join(scratchRoot, "tmp"),
    XDG_CONFIG_HOME: join(scratchRoot, "config"), XDG_DATA_HOME: join(scratchRoot, "data"),
    XDG_STATE_HOME: join(scratchRoot, "state"), XDG_CACHE_HOME: join(scratchRoot, "cache"), XDG_RUNTIME_DIR: join(scratchRoot, "runtime"),
    OPENCODE_DB: join(scratchRoot, "opencode-v2.db"), OPENCODE_TOOLS_DATA_DIR: join(scratchRoot, "tools"), OPENCODE_PLUGINS_DATA_DIR: join(scratchRoot, "plugins"),
    OPENCODE_CONFIG: join(scratchRoot, "config/opencode/opencode.json"), OPENCODE_CONFIG_DIR: join(scratchRoot, "config/opencode"),
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OMO_DISABLE_POSTHOG: "1", OMO_DISABLE_PROCESS_CLEANUP: "1", TERM: "xterm-256color",
  }
  const directory = join(root, "plugin")
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "omo-native-fills-fixture", type: "module", exports: { "./server": "./server.ts" } }))
  writeFileSync(join(directory, "server.ts"), `export { default } from ${JSON.stringify(pathToFileURL(plugin).href)}\n`)
  writeFileSync(join(home, ".omo/omo.jsonc"), JSON.stringify({ "[opencode]": {
    telemetry: false,
    ...(options.scenario === "default-mode" ? { default_mode: { ultrawork: true }, keyword_detector: { disabled_keywords: ["ultrawork", "team", "hyperplan", "hyperplan-ultrawork"] } } : {}),
    agents: Object.fromEntries(["sisyphus", "hephaestus", "prometheus", "atlas", "sisyphus-junior", "oracle", "librarian", "explore", "metis", "momus", "multimodal-looker"].map((name) => [name, { model: name === "hephaestus" ? "fake/gpt-6.1-sol" : "fake/fake-model" }])),
    disabled_hooks: ["native-edition-nudge", "auto-update-checker", "hephaestus-agents-md-injector", "ast-grep-sg-provision"],
    experimental: { disable_live_parent_wake_routing: true },
    claude_code: { mcp: false, commands: false, skills: false, agents: false, hooks: false, plugins: false },
  } }, null, 2))
  return { root, scratchRoot, project, env, binary, plugin, directory }
}

export function configureSandbox(sandbox: ReturnType<typeof createSandbox>, providerPort: number, overflow: boolean) {
  const model = { name: "Fake Model", capabilities: { tools: true }, limit: { context: overflow ? 64000 : 200000, output: 8000 } }
  writeFileSync(join(sandbox.directory, "server.ts"), [
    `import plugin from ${JSON.stringify(pathToFileURL(sandbox.plugin).href)}`,
    `import { installProviderGuard } from ${JSON.stringify(new URL("./v2-parity/provider-guard.ts", import.meta.url).href)}`,
    "export default { ...plugin, async setup(ctx) {",
    "  const cleanup = await plugin.setup(ctx)",
    "  let guard",
    "  try {",
    `    guard = await installProviderGuard(ctx, ${JSON.stringify({ origin: `http://127.0.0.1:${providerPort}`, logFile: join(sandbox.root, "provider-guard.jsonl") })})`,
    "  } catch (error) { await cleanup?.(); throw error }",
    "  return async () => { try { await cleanup?.() } finally { await guard() } }",
    "} }",
  ].join("\n"))
  writeFileSync(sandbox.env.OPENCODE_CONFIG, JSON.stringify({
    model: "fake/fake-model", plugins: [pathToFileURL(sandbox.directory).href],
    policies: [{ action: "provider.use", resource: "*", effect: "deny" }, { action: "provider.use", resource: "fake", effect: "allow" }],
    providers: { fake: { name: "Isolated fake", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "fixture-only" }, models: { "fake-model": model, "gpt-6.1-sol": model } } },
    experimental: { todo: true, codemode: false, background_compaction: false },
    compaction: { auto: true, keep: { tokens: 0 } },
  }, null, 2))
}

export function evidenceWriter(root: string, privateValues: readonly string[]) {
  const sanitize = (text: string) => privateValues.reduce((value, secret) => value.replaceAll(secret, "<private>"), text)
    .replace(/"(?:authorization|apiKey|password)"\s*:\s*"(?:\\.|[^"\\])*"/gi, '"credential":"<private>"')
  return {
    sanitize,
    save: (name: string, value: unknown) => {
      requireProof(!name.includes("/") && !name.includes("\\"), "Evidence filename must be a basename")
      writeFileSync(join(root, name), sanitize(typeof value === "string" ? value : JSON.stringify(value, null, 2)))
    },
  }
}

export function fingerprint(path: string) {
  requireProof(existsSync(path), "Candidate artifact is absent")
  return Bun.file(path).arrayBuffer().then((bytes) => createHash("sha256").update(new Uint8Array(bytes)).digest("hex"))
}
