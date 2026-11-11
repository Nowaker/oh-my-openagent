import { existsSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs"
import { resolve, join, dirname, relative, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { createHash, randomBytes } from "node:crypto"
import { z } from "zod"

if (!process.argv[2] || !process.argv[3]) throw new Error("Usage: bun script/qa/v2-bridge-spike.ts <scratch-root> <v2-binary> [plugin-bundle] [turn]")
const root = resolve(process.argv[2])
const binary = resolve(process.argv[3])
const plugin = resolve(process.argv[4] ?? "dist/index.js")
for (const name of ["home/project", "config/opencode", "data", "state", "cache", "tmp", "tools", "plugins", "plugin"]) mkdirSync(join(root, name), { recursive: true })
const project = join(root, "home/project")
const home = realpathSync(join(root, "home"))
for (let current = realpathSync(project); ; current = dirname(current)) {
  const withinRoot = relative(realpathSync(root), current)
  if (withinRoot === ".." || withinRoot.startsWith(`..${sep}`)) throw new Error("Project config walk escapes the scratch root")
  if (current === home) break
  if (dirname(current) === current) throw new Error("Scratch HOME is not an ancestor of the project")
}
const pluginDirectory = join(root, "plugin")
const tuiBundle = join(dirname(plugin), "tui.js")
writeFileSync(join(pluginDirectory, "package.json"), JSON.stringify({ name: "omo-v2-spike-fixture", type: "module", exports: { "./server": "./server.ts", ...(existsSync(tuiBundle) ? { "./tui": "./tui.ts" } : {}) } }))
writeFileSync(join(pluginDirectory, "server.ts"), `export { default } from ${JSON.stringify(pathToFileURL(plugin).href)}\n`)
if (existsSync(tuiBundle)) writeFileSync(join(pluginDirectory, "tui.ts"), `export { default } from ${JSON.stringify(pathToFileURL(tuiBundle).href)}\n`)
const scratchEnv = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: join(root, "home"),
  TMPDIR: join(root, "tmp"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
  OPENCODE_DB: join(root, "opencode-v2.db"),
  OPENCODE_TOOLS_DATA_DIR: join(root, "tools"),
  OPENCODE_PLUGINS_DATA_DIR: join(root, "plugins"),
  OPENCODE_CONFIG: join(root, "config/opencode/opencode.json"),
  OPENCODE_CONFIG_DIR: join(root, "config/opencode"),
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OMO_DISABLE_POSTHOG: "1",
  OMO_DISABLE_PROCESS_CLEANUP: "1",
  TERM: "xterm-256color",
}
writeFileSync(join(root, "isolation.json"), JSON.stringify({ binary, plugin, cwd: project, env: scratchEnv }, null, 2))

const modelRequest = z.object({ model: z.string().optional(), stream: z.boolean().optional(), messages: z.array(z.object({ role: z.string(), content: z.unknown() })).optional(), tools: z.array(z.object({ function: z.object({ name: z.string() }).passthrough() }).passthrough()).optional() }).passthrough()
const requests: z.infer<typeof modelRequest>[] = []
let missingOmoTool = false
let omoOnlyToolExecuted = false
const provider = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(req) {
    if (req.method === "GET") return Response.json({ data: [{ id: "fake-model", object: "model" }] })
    const body = modelRequest.parse(await req.json())
    requests.push(body)
    writeFileSync(join(root, "provider-requests.json"), JSON.stringify(requests, null, 2))
    const called = body.messages?.filter((m) => m.role === "tool").length ?? 0
    const tool = body.tools?.find((t) => t.function.name === "glob")
    const backgroundOutput = body.tools?.find((t) => t.function.name === "background_output")
    if (body.tools && !backgroundOutput) missingOmoTool = true
    const call = tool && backgroundOutput && called < 2
      ? { id: called === 0 ? "call_spike_glob" : "call_spike_background", name: called === 0 ? "glob" : "background_output", args: called === 0 ? { pattern: "*.txt", path: project } : { task_id: "spike-no-task", block: false } }
      : undefined
    const delta = call
      ? { tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] }
      : { content: missingOmoTool ? "Bridge tool admission failed: background_output is missing." : "Found bridge-demo.txt. The scratch background task spike-no-task does not exist." }
    const chunk = (part: object, finish: string | null) => `data: ${JSON.stringify({ id: "chatcmpl-spike", object: "chat.completion.chunk", created: 1, model: body.model ?? "fake-model", choices: [{ index: 0, delta: part, finish_reason: finish }] })}\n\n`
    return new Response(chunk({ role: "assistant", ...delta }, null) + chunk({}, call ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  },
})
writeFileSync(join(project, "bridge-demo.txt"), "OMO v2 bridge fixture\n")
writeFileSync(join(root, "config/opencode/opencode.json"), JSON.stringify({
  model: "fake/fake-model",
  plugins: [pathToFileURL(pluginDirectory).href],
  providers: { fake: { name: "Isolated fake", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture-only" }, models: { "fake-model": { name: "Fake Model", capabilities: { tools: true }, limit: { context: 200000, output: 8000 } }, "gpt-6.1-sol": { name: "Fake GPT model", capabilities: { tools: true }, limit: { context: 200000, output: 8000 } } } } },
  experimental: { todo: true },
}, null, 2))
writeFileSync(join(root, "home/.omo-placeholder"), "scratch home\n")
mkdirSync(join(root, "home/.omo"), { recursive: true })
writeFileSync(join(root, "home/.omo/omo.jsonc"), JSON.stringify({ "[opencode]": {
  telemetry: false,
  agents: Object.fromEntries(["sisyphus", "hephaestus", "prometheus", "atlas", "sisyphus-junior", "oracle", "librarian", "explore", "metis", "momus", "multimodal-looker"].map((name) => [name, { model: name === "hephaestus" ? "fake/gpt-6.1-sol" : "fake/fake-model" }])),
  disabled_hooks: ["native-edition-nudge", "auto-update-checker", "hephaestus-agents-md-injector", "ast-grep-sg-provision"],
  experimental: { disable_live_parent_wake_routing: true },
  claude_code: { mcp: false, commands: false, skills: false, agents: false, hooks: false, plugins: false },
} }, null, 2))

const password = randomBytes(24).toString("base64url")
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
const tuiSocket = `/tmp/omo-v2-spike-${process.pid}.sock`
let tuiStarted = false
const eventsAbort = new AbortController()
let captureEvents: Promise<void> | undefined
let eventsFailure: unknown
const proc = Bun.spawn([binary, "serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0", "--print-logs", "--log-level", "debug"], { cwd: project, env: { ...scratchEnv, OPENCODE_PASSWORD: password }, stdin: "pipe", stdout: "pipe", stderr: Bun.file(join(root, "server-stderr.log")) })
const deadline = setTimeout(() => proc.kill("SIGKILL"), 180000)
try {
  const reader = proc.stdout.getReader()
  let text = ""
  let url: string | undefined
  while (url === undefined) {
    const next = await reader.read()
    if (next.done) throw new Error("Server exited before readiness")
    text += new TextDecoder().decode(next.value)
    for (const line of text.split("\n").filter((line) => line.startsWith("{"))) {
      const parsed = z.object({ url: z.string().optional() }).parse(JSON.parse(line))
      if (parsed.url) url = parsed.url
    }
  }
  const endpoint = url
  const api = async (path: string, body?: unknown): Promise<unknown> => {
    const target = new URL(path, endpoint)
    target.searchParams.set("location[directory]", project)
    const response = await fetch(target, { method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }), headers: { "content-type": "application/json", authorization }, signal: AbortSignal.timeout(90000) })
    if (!response.ok) throw new Error(`API ${path}: HTTP ${response.status}: ${(await response.text()).slice(0, 2000)}`)
    return response.status === 204 ? null : response.json()
  }
  const eventsUrl = new URL("/api/event", endpoint)
  writeFileSync(join(root, "resolved-config.json"), JSON.stringify(await api("/api/config"), null, 2))
  eventsUrl.searchParams.set("location[directory]", project)
  const eventsTimer = setTimeout(() => eventsAbort.abort(), 60000)
  const eventsResponse = await fetch(eventsUrl, { headers: { authorization }, signal: eventsAbort.signal })
  if (!eventsResponse.ok || !eventsResponse.body) throw new Error(`SSE: HTTP ${eventsResponse.status}`)
  const events = eventsResponse.body.getReader()
  await api("/api/agent")
  let stream = ""
  let ready = false
  while (!ready) {
    const chunk = await events.read()
    if (chunk.done) throw new Error("Event stream closed before plugin activation")
    stream += new TextDecoder().decode(chunk.value)
    writeFileSync(join(root, "events.txt"), stream)
    if (stream.includes('"type":"plugin.updated"')) {
      const inventory = z.object({ data: z.array(z.object({ id: z.string().optional(), state: z.unknown() }).passthrough()) }).parse(await api("/api/plugin"))
      writeFileSync(join(root, "plugins-loading.json"), JSON.stringify(inventory, null, 2))
      ready = inventory.data.some((entry) => entry.id === "oh-my-openagent" || JSON.stringify(entry).includes(pluginDirectory))
    }
  }
  clearTimeout(eventsTimer)
  captureEvents = (async () => {
    try {
      for (;;) {
        const chunk = await events.read()
        if (chunk.done) break
        stream += new TextDecoder().decode(chunk.value)
        writeFileSync(join(root, "events.txt"), stream)
      }
    } catch (error) {
      if (!eventsAbort.signal.aborted) eventsFailure = error
    }
  })()
  for (const [name, path] of [["info", "/api/info"], ["plugins", "/api/plugin"], ["agents", "/api/agent"], ["models", "/api/model"], ["mcp", "/api/mcp"]]) {
    writeFileSync(join(root, `${name}.json`), JSON.stringify(await api(path), null, 2))
  }
  const candidate = z.object({ data: z.array(z.object({ id: z.string().optional(), state: z.object({ status: z.string() }).passthrough() }).passthrough()) }).parse(JSON.parse(readFileSync(join(root, "plugins.json"), "utf8"))).data.find((entry) => entry.id === "oh-my-openagent")
  if (candidate?.state.status !== "active") throw new Error("OMO bridge plugin is not active")
  if (process.argv[5] === "turn") {
    const created = z.object({ data: z.object({ id: z.string() }) }).parse(await api("/api/session", { title: "Sisyphus OMO v2 bridge demo", agent: "sisyphus", model: { providerID: "fake", id: "fake-model" }, permissions: [{ action: "*", resource: "*", effect: "allow" }] }))
    const id = created.data.id
    if (process.argv[6] === "tui") {
      const started = Bun.spawnSync(["tmux", "-S", tuiSocket, "new-session", "-d", "-s", "demo", "-x", "120", "-y", "40", binary, "--server", endpoint, "--session", id, project], { cwd: project, env: { ...scratchEnv, OPENCODE_PASSWORD: password }, stdout: "pipe", stderr: "pipe" })
      writeFileSync(join(root, "tmux-start.txt"), new TextDecoder().decode(started.stderr))
      if (started.exitCode !== 0) throw new Error("Isolated tmux TUI did not start")
      tuiStarted = true
    }
    await api(`/api/session/${id}/prompt`, { text: "List the text files in this workspace with glob and tell me what you found. Also check whether the scratch background task spike-no-task exists with background_output." })
    await api(`/api/experimental/session/${id}/wait`, {})
    const messages = await api(`/api/session/${id}/message`)
    writeFileSync(join(root, "messages.json"), JSON.stringify(messages, null, 2))
    if (missingOmoTool) throw new Error("OMO-only background_output was not admitted into the model's tool registry")
    const rows = z.object({ data: z.array(z.object({ type: z.string(), content: z.array(z.object({ type: z.string(), name: z.string().optional(), state: z.object({ status: z.string(), content: z.unknown().optional() }).passthrough().optional() }).passthrough()).optional() }).passthrough()) }).parse(messages).data
    const glob = rows.flatMap((message) => message.content ?? []).find((part) => part.type === "tool" && part.name === "glob" && part.state?.status === "completed")
    if (!glob || !JSON.stringify(glob.state?.content).includes("Found 1 file(s)") || !JSON.stringify(glob.state?.content).includes("bridge-demo.txt")) throw new Error("Expected OMO glob implementation result was not recorded")
    const background = rows.flatMap((message) => message.content ?? []).find((part) => part.type === "tool" && part.name === "background_output" && part.state?.status === "completed")
    if (!background || !JSON.stringify(background.state?.content).includes("Task not found: spike-no-task")) throw new Error("Expected OMO-only background_output result was not recorded")
    omoOnlyToolExecuted = true
    writeFileSync(join(root, "export.json"), JSON.stringify(await api(`/api/experimental/session/${id}/export`), null, 2))
    writeFileSync(join(root, "session.json"), JSON.stringify({ id, url: endpoint, root }, null, 2))
    if (tuiStarted) {
      const attachment = Bun.spawn(["script", "-q", "-c", `exec tmux -S ${tuiSocket} attach-session -t demo`, "/dev/null"], { cwd: project, env: scratchEnv, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
      const renderTimeout = setTimeout(() => attachment.kill("SIGKILL"), 60000)
      const display = attachment.stdout.getReader()
      let frame = ""
      try {
        while (!frame.includes("Sisyphus")) {
          const chunk = await display.read()
          if (chunk.done) throw new Error("TUI exited before Sisyphus rendered")
          frame += new TextDecoder().decode(chunk.value)
        }
        writeFileSync(join(root, "tui-stream.ansi"), frame)
      } finally {
        clearTimeout(renderTimeout)
        attachment.kill("SIGTERM")
        await attachment.exited
      }
      const capture = Bun.spawnSync(["tmux", "-S", tuiSocket, "capture-pane", "-p", "-t", "demo"], { env: scratchEnv, stdout: "pipe", stderr: "pipe" })
      if (capture.exitCode !== 0) throw new Error("Isolated tmux TUI exited before capture")
      writeFileSync(join(root, "tui.txt"), capture.stdout)
    }
  }
  eventsAbort.abort()
  await captureEvents
  if (eventsFailure !== undefined) throw eventsFailure
  const agents = z.object({ data: z.array(z.object({ id: z.string(), system: z.string().optional() }).passthrough()) }).parse(JSON.parse(readFileSync(join(root, "agents.json"), "utf8"))).data
  const sisyphus = agents.find((agent) => agent.id === "sisyphus")
  const logPath = join(root, "tmp/oh-my-opencode.log")
  const modelTools = [...new Set(requests.flatMap((request) => request.tools ?? []).map((tool) => tool.function.name))].sort()
  const logText = existsSync(logPath) ? readFileSync(logPath, "utf8") : ""
  const submitted = [...logText.matchAll(/tool definitions submitted (\{[^\n]+\})/g)].flatMap((match) => z.object({ names: z.array(z.string()) }).parse(JSON.parse(match[1] ?? "")).names)
  const missing = [...new Set(submitted)].filter((name) => !modelTools.includes(name))
  if (process.argv[5] === "turn" && missing.length > 0) throw new Error(`OMO tools missing from the model registry: ${missing.join(", ")}`)
  const unsupported = existsSync(logPath)
    ? [...readFileSync(logPath, "utf8").matchAll(/unsupported v1 call \{"method":"([^"]+)"\}/g)].map((match) => match[1])
    : []
  const promptDelivered = sisyphus?.system === undefined ? false : JSON.stringify(requests).includes(JSON.stringify(sisyphus.system).slice(1, -1))
  const summary = {
    root, requests: requests.length, pluginState: candidate.state.status,
    agents: agents.map((agent) => agent.id),
    sisyphusPromptSha256: sisyphus?.system === undefined ? null : createHash("sha256").update(sisyphus.system).digest("hex"),
    promptDelivered,
    modelTools, admittedOmoTools: [...new Set(submitted)].sort(), omoOnlyToolExecuted,
    unsupportedCalls: [...new Set(unsupported)].sort(),
    eventTypes: [...new Set([...stream.matchAll(/"type":"(session\.[^"]+)"/g)].map((match) => match[1]))].sort(),
    tuiCaptured: tuiStarted,
  }
  if (process.argv[5] === "turn" && !promptDelivered) throw new Error("Resolved Sisyphus prompt did not reach the fake provider")
  writeFileSync(join(root, "qa-summary.json"), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary))
} finally {
  clearTimeout(deadline)
  eventsAbort.abort()
  await captureEvents
  if (tuiStarted) Bun.spawnSync(["tmux", "-S", tuiSocket, "kill-server"], { env: scratchEnv, stdout: "ignore", stderr: "ignore" })
  proc.stdin.end()
  const cleanup = setTimeout(() => proc.kill("SIGKILL"), 10000)
  await proc.exited
  clearTimeout(cleanup)
  await provider.stop(true)
}
