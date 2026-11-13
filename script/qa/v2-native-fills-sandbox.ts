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
  const binary = realpathSync(options.binary)
  const plugin = realpathSync(options.plugin)
  accessSync(binary, constants.X_OK)
  accessSync(plugin, constants.R_OK)
  for (const part of ["home/project", "config/opencode", "data", "state", "cache", "tmp", "tools", "plugins", "plugin", "runtime", "home/.omo"]) mkdirSync(join(root, part), { recursive: true })
  const home = realpathSync(join(root, "home"))
  const project = realpathSync(join(home, "project"))
  for (let current = project; ; current = dirname(current)) {
    const path = relative(root, current)
    requireProof(path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path), "Project config walk escaped the scratch root")
    if (current === home) break
    requireProof(dirname(current) !== current, "Scratch HOME must enclose the project")
  }
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: join(root, "tmp"),
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"), XDG_RUNTIME_DIR: join(root, "runtime"),
    OPENCODE_DB: join(root, "opencode-v2.db"), OPENCODE_TOOLS_DATA_DIR: join(root, "tools"), OPENCODE_PLUGINS_DATA_DIR: join(root, "plugins"),
    OPENCODE_CONFIG: join(root, "config/opencode/opencode.json"), OPENCODE_CONFIG_DIR: join(root, "config/opencode"),
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
  return { root, project, env, binary, plugin, directory }
}

export function configureSandbox(sandbox: ReturnType<typeof createSandbox>, providerPort: number, overflow: boolean) {
  const model = { name: "Fake Model", capabilities: { tools: true }, limit: { context: overflow ? 64000 : 200000, output: 8000 } }
  writeFileSync(sandbox.env.OPENCODE_CONFIG, JSON.stringify({
    model: "fake/fake-model", plugins: [pathToFileURL(sandbox.directory).href],
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
